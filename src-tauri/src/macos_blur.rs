use serde::Deserialize;

/// One rounded rect (CSS pixel / top-left origin coordinates) that should
/// show the desktop blur. Reported by the frontend on layout changes.
#[derive(Clone, Debug, Deserialize)]
pub struct BlurRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub radius: f64,
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::c_void;

    use block2::RcBlock;
    use objc2::{
        define_class,
        rc::{Allocated, Retained},
        runtime::Bool,
        DeclaredClass,
    };
    use objc2_app_kit::{
        NSAutoresizingMaskOptions, NSBezierPath, NSColor, NSImage, NSView,
        NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState,
        NSVisualEffectView, NSWindowOrderingMode,
    };
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{MainThreadMarker, NSInteger, NSRect};

    use super::BlurRegion;

    const BLUR_VIEW_TAG: NSInteger = 31_070_801;

    #[derive(Default, Debug, PartialEq, Eq)]
    pub struct SogoVisualEffectViewIvars {
        tag: NSInteger,
    }

    define_class!(
        #[unsafe(super(NSVisualEffectView))]
        #[name = "SogoVisualEffectView"]
        #[ivars = SogoVisualEffectViewIvars]
        pub struct SogoVisualEffectView;

        impl SogoVisualEffectView {
            #[unsafe(method(tag))]
            fn tag(&self) -> NSInteger {
                self.ivars().tag
            }
        }
    );

    impl SogoVisualEffectView {
        unsafe fn init_with_frame(
            this: Allocated<Self>,
            frame: NSRect,
            tag: NSInteger,
        ) -> Retained<Self> {
            let this = this.set_ivars(SogoVisualEffectViewIvars { tag });
            unsafe { objc2::msg_send![super(this), initWithFrame: frame] }
        }
    }

    pub fn install(window: &tauri::WebviewWindow) {
        let Ok(ns_view) = window.ns_view() else {
            return;
        };
        if ns_view.is_null() {
            return;
        }

        unsafe {
            ensure_effect_view(ns_view);
        }
    }

    pub fn apply(window: &tauri::WebviewWindow, regions: &[BlurRegion], enabled: bool) {
        let Ok(ns_view) = window.ns_view() else {
            return;
        };
        if ns_view.is_null() {
            return;
        }

        unsafe {
            apply_inner(ns_view, regions, enabled);
        }
    }

    unsafe fn ensure_effect_view(ns_view: *mut c_void) -> Option<Retained<NSView>> {
        let mtm = MainThreadMarker::new()?;
        let root = &*(ns_view.cast::<NSView>());

        if let Some(existing) = root.viewWithTag(BLUR_VIEW_TAG) {
            return Some(existing);
        }

        let effect =
            SogoVisualEffectView::init_with_frame(mtm.alloc(), root.bounds(), BLUR_VIEW_TAG);
        // Sidebar: stronger frost than UnderWindowBackground, still adapts
        // to light/dark appearance.
        effect.setMaterial(NSVisualEffectMaterial::Sidebar);
        effect.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
        effect.setState(NSVisualEffectState::Active);
        effect.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        // Stay hidden until the frontend reports regions; a bare effect view
        // would flash a full-window frosted rectangle before first layout.
        effect.setHidden(true);

        root.addSubview_positioned_relativeTo(&effect, NSWindowOrderingMode::Below, None);
        root.viewWithTag(BLUR_VIEW_TAG)
    }

    unsafe fn apply_inner(ns_view: *mut c_void, regions: &[BlurRegion], enabled: bool) {
        let Some(view) = ensure_effect_view(ns_view) else {
            return;
        };
        let effect = &*(Retained::as_ptr(&view).cast::<NSVisualEffectView>());

        if !enabled || regions.is_empty() {
            effect.setHidden(true);
            return;
        }

        let root = &*(ns_view.cast::<NSView>());
        let bounds = root.bounds();
        effect.setFrame(bounds);
        effect.setMaskImage(Some(&mask_image(bounds.size, regions)));
        effect.setHidden(false);
    }

    /// Alpha mask: opaque rounded rects on a clear canvas. Drawn flipped so
    /// the frontend's top-left-origin CSS rects map 1:1 without Y math.
    fn mask_image(size: CGSize, regions: &[BlurRegion]) -> Retained<NSImage> {
        let regions = regions.to_vec();
        let handler = RcBlock::new(move |_dest: NSRect| -> Bool {
            NSColor::blackColor().set();
            for region in &regions {
                let rect = CGRect::new(
                    CGPoint::new(region.x, region.y),
                    CGSize::new(region.width, region.height),
                );
                let radius = region
                    .radius
                    .min(region.width / 2.0)
                    .min(region.height / 2.0)
                    .max(0.0);
                NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(rect, radius, radius)
                    .fill();
            }
            Bool::YES
        });
        NSImage::imageWithSize_flipped_drawingHandler(size, true, &handler)
    }
}

#[cfg(target_os = "macos")]
pub fn install(window: &tauri::WebviewWindow) {
    platform::install(window);
}

#[cfg(not(target_os = "macos"))]
pub fn install(_window: &tauri::WebviewWindow) {}

#[cfg(target_os = "macos")]
pub fn update(window: &tauri::WebviewWindow, regions: Vec<BlurRegion>, enabled: bool) {
    let main_thread_window = window.clone();
    let _ = window.run_on_main_thread(move || {
        platform::apply(&main_thread_window, &regions, enabled);
    });
}

#[cfg(not(target_os = "macos"))]
pub fn update(_window: &tauri::WebviewWindow, _regions: Vec<BlurRegion>, _enabled: bool) {}

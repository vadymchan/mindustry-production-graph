// Production Graph - M0 skeleton.
// Press F8 inside a loaded map to toggle an (empty) panel.
// Sampling + graph arrive in M1+.
//
// Notes:
// - The dialog is built lazily on first F8 press, so the UI/scene is
//   guaranteed to be ready (building it at mod-load time can NPE).
// - Trigger.update fires during gameplay; it may not tick in the main
//   menu, so test this inside a loaded sandbox map, not the title screen.

var dialog = null;

function buildDialog() {
  var d = new BaseDialog("Production Graph");
  d.cont.add("Production Graph - M0 skeleton.\nSampling and graph arrive in M1+.").pad(20);
  d.addCloseButton();
  return d;
}

Events.run(Trigger.update, run(function () {
  if (Core.input.keyTap(KeyCode.f8)) {
    if (dialog == null) dialog = buildDialog();
    // parent != null means the dialog is currently shown on the scene.
    if (dialog.parent != null) {
      dialog.hide();
    } else {
      dialog.show();
    }
  }
}));

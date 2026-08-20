ui.ready(function () {
  var newPass = ui.byId('newpass1');
  // both only apply once a new password is actually being set
  var extraBlocks = [ui.byId('newpass2block'), ui.byId('currentpassblock')];

  if (!newPass) {
    return;
  }

  function sync() {
    var setting = newPass.value.length !== 0;
    extraBlocks.forEach(function (block) {
      if (setting) {
        ui.show(block);
      } else {
        ui.hide(block);
      }
    });
  }

  sync();
  ['input', 'change', 'blur', 'keyup'].forEach(function (event) {
    newPass.addEventListener(event, sync);
  });
});

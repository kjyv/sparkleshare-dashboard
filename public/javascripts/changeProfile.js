  $(function() {
    $("#newpass2block").hide();
    $("#currentpassblock").hide();
  });

  function showHideNewPass2() {
    var p1 = $("#newpass1").val();
    if (p1.length) {
      $("#newpass2block").show('fast');
      $("#currentpassblock").show('fast');
    } else {
      $("#newpass2block").hide('fast');
      $("#currentpassblock").hide('fast');
    }
  }

  $("#newpass1").blur(function() {
    showHideNewPass2();
  });

  $("#newpass1").change(function() {
    showHideNewPass2();
  });

  $("#newpass1").keydown(function() {
    showHideNewPass2();
  });

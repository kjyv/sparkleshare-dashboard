// Small DOM helpers shared by the dashboard's pages: show/hide, a fade, and the
// placeholder-label behaviour the login and first-user forms both use.
(function (global) {
  'use strict';

  var FADE_MS = 150;

  function byId(id) {
    return document.getElementById(id);
  }

  function show(el) {
    if (el) {
      el.style.display = '';
      el.style.opacity = '1';
    }
  }

  function hide(el) {
    if (el) {
      el.style.display = 'none';
    }
  }

  function fadeIn(el) {
    if (!el) {
      return;
    }
    el.style.transition = 'opacity ' + FADE_MS + 'ms';
    el.style.display = '';
    // the opacity change has to land in a later frame than the display change,
    // or the browser has nothing to transition from
    global.requestAnimationFrame(function () {
      el.style.opacity = '1';
    });
  }

  function fadeOut(el) {
    if (!el) {
      return;
    }
    el.style.transition = 'opacity ' + FADE_MS + 'ms';
    el.style.opacity = '0';
    global.setTimeout(function () {
      if (el.style.opacity === '0') {
        el.style.display = 'none';
      }
    }, FADE_MS);
  }

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  // The label sits on top of its input as a placeholder, so it hides while the
  // field has content. Polled as well as event-driven because a browser
  // autofilling a saved password fires no input event.
  function placeholderLabel(inputId, labelId) {
    var input = byId(inputId);
    var label = byId(labelId);
    if (!input || !label) {
      return;
    }

    function sync() {
      if (input.value.length !== 0) {
        hide(label);
      }
    }

    input.addEventListener('focus', function () {
      fadeOut(label);
    });
    input.addEventListener('blur', function () {
      if (input.value.length === 0) {
        fadeIn(label);
      }
    });

    sync();
    global.setInterval(sync, 300);
  }

  global.ui = {
    byId: byId,
    show: show,
    hide: hide,
    fadeIn: fadeIn,
    fadeOut: fadeOut,
    ready: ready,
    placeholderLabel: placeholderLabel
  };
})(window);

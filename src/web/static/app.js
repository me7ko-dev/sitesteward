// Small progressive enhancements for the panel (no framework).
(function () {
  // Confirm dangerous actions
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-confirm]');
    if (el && !window.confirm(el.getAttribute('data-confirm'))) e.preventDefault();
  });

  // Copy link
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var input = btn.parentElement.querySelector('[data-copy-source]');
      if (!input) return;
      input.select();
      (navigator.clipboard ? navigator.clipboard.writeText(input.value) : Promise.resolve(document.execCommand('copy')))
        .then(function () { var t = btn.textContent; btn.textContent = '✓'; setTimeout(function () { btn.textContent = t; }, 1200); });
    });
  });

  // Logo upload → data URL in a hidden field (no multipart parsing needed on the server)
  document.querySelectorAll('[data-logo-input]').forEach(function (input) {
    var wrap = input.closest('label');
    var hidden = wrap.querySelector('[data-logo-value]');
    var preview = wrap.querySelector('[data-logo-preview]');
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      if (file.size > 300 * 1024) { alert('Max 300 KB'); input.value = ''; return; }
      var reader = new FileReader();
      reader.onload = function () {
        hidden.value = reader.result;
        preview.replaceChildren();
        var img = document.createElement('img');
        img.src = reader.result;
        preview.appendChild(img);
      };
      reader.readAsDataURL(file);
    });
    var clear = wrap.querySelector('[data-logo-clear]');
    if (clear) clear.addEventListener('click', function () { hidden.value = ''; preview.replaceChildren(); clear.remove(); });
  });
})();

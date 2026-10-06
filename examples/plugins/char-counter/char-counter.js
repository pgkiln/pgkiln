// Character counter (item plug-in): limits the field and shows "used / maximum".
pgapex.plugins.register('char_counter', ({ element, attributes }) => {
  const input = element.querySelector('input, textarea');
  const max = Number(attributes.MAX) || 0;
  if (!input || max <= 0) return;
  input.maxLength = max;
  const out = document.createElement('small');
  out.className = 'help char-counter';
  out.id = `${input.id}_count`;
  out.setAttribute('aria-live', 'polite');
  input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), out.id].filter(Boolean).join(' '));
  const show = () => {
    out.textContent = `${input.value.length} / ${max}`;
    out.classList.toggle('is-full', input.value.length >= max);
  };
  input.addEventListener('input', show);
  input.after(out);
  show();
});

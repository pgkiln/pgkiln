// Show more list (region plug-in): hides rows after the first VISIBLE behind a button.
pgkiln.plugins.register('show_more', ({ element, attributes }) => {
  const rows = [...element.querySelectorAll('.show-more-item')];
  const visible = Math.max(1, Number(attributes.VISIBLE) || 5);
  if (rows.length <= visible) return;
  rows.slice(visible).forEach((row) => (row.hidden = true));
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn show-more-button';
  button.textContent = `${attributes.BUTTON || 'Show all'} (${rows.length})`;
  button.addEventListener('click', () => {
    rows.forEach((row) => (row.hidden = false));
    button.remove();
    // the first row that was hidden takes the focus, so keyboard users carry on there
    rows[visible].tabIndex = -1;
    rows[visible].focus();
  });
  element.append(button);
});

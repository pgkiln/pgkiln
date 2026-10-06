// Copy to clipboard (dynamic action plug-in).
pgapex.plugins.register('copy_value', async (da) => {
  const name = da.items[0];
  if (!name) return;
  await navigator.clipboard.writeText(String(pgapex.getValue(name) ?? ''));
  pgapex.showSuccess(da.attributes.MESSAGE || 'Copied.');
});

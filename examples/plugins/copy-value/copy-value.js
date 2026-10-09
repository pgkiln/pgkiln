// Copy to clipboard (dynamic action plug-in).
pgkiln.plugins.register('copy_value', async (da) => {
  const name = da.items[0];
  if (!name) return;
  await navigator.clipboard.writeText(String(pgkiln.getValue(name) ?? ''));
  pgkiln.showSuccess(da.attributes.MESSAGE || 'Copied.');
});

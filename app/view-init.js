// Applies the saved view (chat or notes) before the first paint; src/ui/views.ts owns it afterwards.
try { document.documentElement.dataset.view = localStorage.getItem('assistant:view') === 'notes' ? 'notes' : 'chat'; }
catch { document.documentElement.dataset.view = 'chat'; }

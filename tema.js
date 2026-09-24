// Aplica o tema salvo ANTES de a página pintar — por isso é um arquivo
// síncrono no <head>, e não parte do app.js: carregado depois, a página
// piscaria no tema errado. Mora em arquivo (e não inline) porque a CSP não
// aceita script inline.
try {
  const t = localStorage.getItem('theme');
  if (t) document.documentElement.setAttribute('data-theme', t);
  else if (window.matchMedia('(prefers-color-scheme: light)').matches) document.documentElement.setAttribute('data-theme', 'light');
} catch(e) {}

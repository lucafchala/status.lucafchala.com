// Aplica o tema salvo ANTES de a página pintar — por isso é um arquivo
// síncrono no <head>, e não parte do app.js: carregado depois, a página
// piscaria no tema errado. Mora em arquivo (e não inline) porque a CSP não
// aceita script inline.
//
// Tema e idioma são compartilhados por todo o ecossistema: os cookies
// `lf_theme` / `lf_lang` no domínio .lucafchala.com (a escolha feita em
// qualquer *.lucafchala.com vale aqui), depois o localStorage, depois o
// sistema/navegador. Mesmo formato do theme.js do paste e do keys.
(function () {
  var d = document.documentElement;
  function cookie(n) { var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; }
  function lido(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function salva(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { /* modo privado */ }
    var dom = /(^|\.)lucafchala\.com$/.test(location.hostname) ? '; Domain=.lucafchala.com' : '';
    document.cookie = 'lf_' + k + '=' + encodeURIComponent(v) + dom + '; Path=/; Max-Age=31536000; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
  }
  var tema = cookie('lf_theme') || lido('theme');
  if (tema !== 'light' && tema !== 'dark') tema = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  var lang = cookie('lf_lang') || lido('lang');
  if (lang !== 'pt' && lang !== 'en') lang = /^pt/i.test(navigator.language || '') ? 'pt' : 'en';
  d.setAttribute('data-theme', tema);
  d.lang = lang === 'en' ? 'en' : 'pt-BR';
  window.lfPrefs = { theme: tema, lang: lang, save: salva };
})();

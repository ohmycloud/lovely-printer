// Semantic tokens keep the printer, paper and canvas in the same palette.
export const THEMES = {
  cream: {
    name: '奶油复古', description: '米白塑料 · 陶土红 · 琥珀屏幕',
    colors: { shell: '#e5e1d6', base: '#c5c2b0', accent: '#c36649', accentShadow: '#9f452d', printInk: '#ffffff', screen: '#1a1c1a', screenText: '#f1ad47', well: '#d1cebf', heart: '#fdfdfa', label: '#5a5850', paper: '#ffffff', paperInk: '#1f2937', background: '#f0f2f5', header: '#8f96a1', footer: '#9ca3af' }
  },
  sky: {
    name: '晴空蓝', description: '浅蓝机身 · 午夜蓝 · 青色荧光',
    colors: { shell: '#a4d4ed', base: '#7caecb', accent: '#43bce7', accentShadow: '#2993bf', printInk: '#202749', screen: '#1d2345', screenText: '#8de5ed', well: '#8cbfdc', heart: '#8b9edf', label: '#254b64', paper: '#effaff', paperInk: '#203650', background: '#83b6e7', header: '#345a7e', footer: '#466c93' }
  },
  sage: {
    name: '鼠尾草绿', description: '柔雾绿 · 松针绿 · 温暖纸张',
    colors: { shell: '#becdb8', base: '#8fa58a', accent: '#57755f', accentShadow: '#3c5543', printInk: '#f7f6e9', screen: '#202d27', screenText: '#c6dfaa', well: '#a5b69f', heart: '#f0f1dc', label: '#435746', paper: '#fff9e7', paperInk: '#344636', background: '#e4eada', header: '#6b8069', footer: '#84917a' }
  }
};
export const COLOR_FIELDS = {
  shell: '机身', accent: 'PRINT / 强调色', screen: '屏幕底色', screenText: '屏幕文字',
  paper: '便签纸张', paperInk: '便签正文', background: '画布背景', header: 'Header 颜色', footer: 'Footer 颜色'
};
const TOKENS = { shell: '--shell', base: '--shell-base', accent: '--terracotta', accentShadow: '--accent-shadow', printInk: '--print-ink', screen: '--screen', screenText: '--screen-text', well: '--control-well', heart: '--heart', label: '--machine-label', paper: '--paper', paperInk: '--paper-ink', background: '--canvas-bg', header: '--header-color', footer: '--footer-color' };
export function sanitizeAppearance(settings) {
  if (!Object.hasOwn(THEMES, settings.themeId)) settings.themeId = 'cream';
  const overrides = {};
  for (const id of Object.keys(THEMES)) {
    overrides[id] = {};
    for (const key of Object.keys(COLOR_FIELDS)) {
      const value = settings.themeOverrides?.[id]?.[key];
      if (typeof value === 'string' && /^#[\da-f]{6}$/i.test(value)) overrides[id][key] = value;
    }
  }
  settings.themeOverrides = overrides;
  const textDefaults = { headerText: 'a little love, on paper.', footerText: 'TYPE A THOUGHT. KEEP A MOMENT.', paperHeaderText: 'ID: {id}', paperFooterText: 'End of Transmission' };
  for (const [key, fallback] of Object.entries(textDefaults)) {
    settings[key] = typeof settings[key] === 'string' ? settings[key].replace(/[\x00-\x1f\x7f]/g, '').slice(0, key === 'paperHeaderText' ? 32 : key === 'paperFooterText' ? 48 : 100) : fallback;
  }
  settings.lyricsQuery = typeof settings.lyricsQuery === 'string' ? settings.lyricsQuery.trim().slice(0, 100) : '海阔天空';
}
export function themeColors(settings) { return { ...THEMES[settings.themeId].colors, ...settings.themeOverrides[settings.themeId] }; }
export function applyTheme(settings) {
  const colors = themeColors(settings);
  document.documentElement.dataset.theme = settings.themeId;
  for (const [key, token] of Object.entries(TOKENS)) document.documentElement.style.setProperty(token, colors[key]);
  // Custom accent colors also get a corresponding physical button depth.
  if (settings.themeOverrides[settings.themeId].accent) document.documentElement.style.setProperty('--accent-shadow', `color-mix(in srgb, ${colors.accent} 75%, black)`);
  document.querySelector('meta[name="theme-color"]').content = colors.background;
}

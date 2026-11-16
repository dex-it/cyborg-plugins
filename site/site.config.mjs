// Адрес сайта и бренд: единственное место, откуда их читают конфиг Astro и проверка сборки.
//
// Адрес GitHub Pages задаёт имя репозитория: https://<организация>.github.io/<репозиторий>/.
// Репозиторий переименуют - меняются REPO_NAME (и, при смене организации, OWNER) в этом файле,
// остальное (base, canonical, sitemap, ссылки, проверка dist) подтягивается отсюда.

export const OWNER = 'dex-it';
export const REPO_NAME = 'cyborg-plugins';

export const ORIGIN = `https://${OWNER}.github.io`;
export const BASE = `/${REPO_NAME}`;
export const SITE_URL = `${ORIGIN}${BASE}/`;
export const REPO = `https://github.com/${OWNER}/${REPO_NAME}`;

export const BRAND = 'Cyborg Plugins';
export const TAGLINE = 'Плагины и бандлы для приложений на ядре Cyborg Harness';
export const DESCRIPTION =
  'Cyborg Plugins - репозиторий плагинов для приложений на ядре Cyborg Harness: каталог по назначению, бандлы для установки пачкой, руководство автору плагина.';

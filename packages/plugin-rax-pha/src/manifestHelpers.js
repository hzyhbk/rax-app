const { decamelize } = require('humps');
const pathPackage = require('path');
const { manifestRetainKeys: retainKeys, manifestCamelizeKeys: camelizeKeys } = require('./manifestWhiteList');
const ejs = require('ejs');
const fs = require('fs-extra');
const path = require('path');

// transform app config to decamelize
function transformAppConfig(appConfig, isRoot = true, parentKey) {
  const data = {};

  if (isRoot && appConfig.routes) {
    appConfig.pages = appConfig.routes;
  }
  for (let key in appConfig) {
    // filter not need key
    if (isRoot && retainKeys.indexOf(key) === -1) {
      continue;
    }
    const value = appConfig[key];

    // compatible tabHeader
    if (key === 'pageHeader') {
      key = 'tabHeader';
    }

    let transformKey = key;
    if (camelizeKeys.indexOf(key) === -1) {
      transformKey = decamelize(key);
    }
    if (key === 'window') {
      Object.assign(data, transformAppConfig(value, false));
    } else if (typeof value === 'string' || typeof value === 'number') {
      data[transformKey] = value;
    } else if (Array.isArray(value)) {
      data[transformKey] = value.map((item) => {
        if (parentKey === 'tabBar' && item.text) {
          item.name = item.text;
          delete item.text;
        }
        if (typeof item === 'object') {
          if (key === 'dataPrefetch') {
            // hack: No header will crash in Android
            if (!item.header) {
              item.header = {};
            }

            // no prefetchKey will crash in Android TaoBao 9.26.0
            if (!item.prefetchKey) {
              item.prefetchKey = 'mtop';
            }
          }
          return transformAppConfig(item, false, key);
        }
        return item;
      });
    } else if (key === 'requestHeaders') {
      // keys of requestHeaders should not be transformed
      data[transformKey] = value;
    } else if (key === 'tabBar') {
      // Transform to html string by metas,links and scripts.
      const { metas = [], links = [], scripts = [] } = value;

      delete value['metas'];
      delete value['links'];
      delete value['scripts'];

      const template = fs.readFileSync(path.join(__dirname, './html.ejs'), 'utf-8');
      const html = ejs.render(template, {
        metas,
        links,
        scripts,
      });

      data[transformKey] = {
        ...value,
        html,
      };
    } else if (typeof value === 'object' && !(parentKey === 'dataPrefetch' && (key === 'header' || key === 'data'))) {
      data[transformKey] = transformAppConfig(value, false, key);
    } else {
      data[transformKey] = value;
    }
  }

  // console.log('data=', data);
  return data;
}

function getRealPageInfo({ urlPrefix, urlSuffix = '' }, page) {
  const { source, name, query_params = '' } = page;
  let entryName;
  if (name) {
    entryName = name;
    page.key = name;
  } else if (source) {
    const dir = pathPackage.dirname(source);
    entryName = pathPackage.parse(dir).name.toLocaleLowerCase();
  }
  let pageUrl = '';
  if (entryName) {
    pageUrl = `${urlPrefix + entryName + urlSuffix}`;
  }

  if (pageUrl && query_params) {
    pageUrl = `${pageUrl}?${query_params}`;
  }

  delete page.source;

  return {
    pageUrl,
    entryName,
  };
}

/*
 * change page info
 */
function changePageInfo({ urlPrefix, urlSuffix = '', cdnPrefix, isTemplate, api, assetNames = [] }, page) {
  const { applyMethod } = api;
  const { source, name } = page;
  if (!source && !name) {
    return page;
  }

  const { document, custom } = applyMethod('rax.getDocument', { name, source }) || {};
  const { entryName, pageUrl } = getRealPageInfo(
    {
      urlPrefix,
      urlSuffix,
    },
    page,
  );

  if (entryName) {
    if (page.url) {
      page.path = page.url;
      delete page.url;
      return page;
    }

    if (!page.path || !page.path.startsWith('http')) {
      page.path = pageUrl;
    }

    // template and no frames under the page
    if (isTemplate && !Array.isArray(page.frames)) {
      if (custom) {
        page.document = document;
        return page;
      }

      // add script and stylesheet
      const scriptName = `${entryName}.js`;
      if (assetNames.includes(scriptName)) {
        page.script = cdnPrefix + scriptName;
      }

      const stylesheetName = `${entryName}.css`;
      if (assetNames.includes(stylesheetName)) {
        page.stylesheet = cdnPrefix + stylesheetName;
      }
    }
  }

  return page;
}

/**
 * set real url to manifest
 */
function setRealUrlToManifest(options, manifest) {
  const { urlPrefix, cdnPrefix, api } = options;
  const { applyMethod } = api;
  if (!urlPrefix) {
    return manifest;
  }

  const { app_worker, tab_bar, pages } = manifest;
  if (app_worker && app_worker.url && !app_worker.url.startsWith('http')) {
    app_worker.url = cdnPrefix + app_worker.url;
  }

  if (tab_bar && tab_bar.source) {
    if (!tab_bar.url) {
      // TODO: iOS issue
      // TODO: should remove it in PHA 2.x
      // PHA 1.x should inject `url` to be a base url to load assets
      tab_bar.url = getRealPageInfo(options, tab_bar).pageUrl;
      // TODO: Android issue
      // TODO: should remove it in PHA 2.x
      // same as iOS issue
      try {
        tab_bar.name = new URL(tab_bar.url).origin;
      } catch (e) {
        // HACK: build type of Weex will inject an invalid URL,
        // which will throw Error when stringify using `new URL()`
        // invalid URL: {{xxx}}/path
        // {{xxx}} will replace by server
        [tab_bar.name] = tab_bar.url.split('/');
      }
    }
    delete tab_bar.source;
  }

  // items is `undefined` will crash in PHA
  if (tab_bar && tab_bar.list) {
    tab_bar.items = tab_bar.list.map(() => ({}));
    delete tab_bar.list;
  }

  if (pages && pages.length > 0) {
    manifest.pages = pages.map((page) => {
      // has frames
      if (page.frames && page.frames.length > 0) {
        page.frames = page.frames.map((frame) => {
          return changePageInfo(options, frame, manifest);
        });
      }

      if (page.tab_header && page.tab_header.source) {
        const { document, custom } =
          applyMethod('rax.getDocument', { name: page.tab_header.name, source: page.tab_header.source }) || {};
        if (!page.tab_header.url) {
          if (custom) {
            page.tab_header.html = document;
          }
          // TODO: iOS issue
          // TODO: should remove it in PHA 2.x
          // PHA 1.x should inject `url` to be a base url to load assets
          page.tab_header.url = getRealPageInfo(options, page.tab_header).pageUrl;
          // TODO: Android issue
          // TODO: should remove it in PHA 2.x
          // same as iOS issue
          try {
            page.tab_header.name = new URL(page.tab_header.url).origin;
          } catch (e) {
            // HACK: build type of Weex will inject an invalid URL,
            // which will throw Error when stringify using `new URL()`
            // invalid URL: {{xxx}}/path
            // {{xxx}} will replace by server
            [page.tab_header.name] = page.tab_header.url.split('/');
          }
        }
        delete page.tab_header.source;
      }
      return changePageInfo(options, page, manifest);
    });
  }

  return manifest;
}

module.exports = {
  transformAppConfig,
  setRealUrlToManifest,
};

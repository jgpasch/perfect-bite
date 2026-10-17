// Safari runs this in the page before the share sheet opens (NSExtensionJavaScriptPreprocessingFile).
// It hands ShareViewController the page's URL, title, JSON-LD blocks, readable text and photo tag
// (`imageUrl`, as CAPTURE_SCRIPT reads it; without it a page whose JSON-LD has no photo imported
// with none, spec 6.6 step 5), so pages
// behind a sign-in or paywall import from what the user sees (spec 4.10, 6.6).
// The capture is copied from CAPTURE_SCRIPT in src/features/recipes/page-capture.ts, with the caps of
// `RecipeImportPageSchema` inlined: each JSON-LD block ≤ 200 KB, at most 10; text ≤ 50 KB (UTF-8
// bytes). A block over its cap is dropped, since cut JSON doesn't parse.
// src/features/recipes/__tests__/share-preprocess.test.ts checks the caps.
var Preprocess = function () {};

Preprocess.prototype = {
  run: function (args) {
    var MAX_BLOCKS = 10;
    var MAX_BLOCK_BYTES = 204800;
    var MAX_TEXT_BYTES = 51200;
    var MAX_IMAGE_URL_LENGTH = 2048;
    var encoder = new TextEncoder();
    var decoder = new TextDecoder();
    function bytes(s) {
      return encoder.encode(s).length;
    }
    function cut(s, max) {
      var encoded = encoder.encode(s);
      if (encoded.length <= max) return s;
      return decoder.decode(encoded.slice(0, max)).replace(/�+$/, '');
    }

    // PAGE_IMAGE_SOURCES from page-capture.ts: the first non-empty attribute is the page's imageUrl.
    var IMAGE_SOURCES = [["meta[property=\"og:image\"]","content"],["meta[name=\"og:image\"]","content"],["meta[property=\"og:image:secure_url\"]","content"],["meta[name=\"og:image:secure_url\"]","content"],["meta[property=\"og:image:url\"]","content"],["meta[name=\"og:image:url\"]","content"],["meta[property=\"twitter:image\"]","content"],["meta[name=\"twitter:image\"]","content"],["meta[property=\"twitter:image:src\"]","content"],["meta[name=\"twitter:image:src\"]","content"],["link[rel~=\"image_src\"]","href"],["[itemprop~=\"image\"]","content","src","href"]];
    function pageImage() {
      try {
        for (var i = 0; i < IMAGE_SOURCES.length; i++) {
          var el = document.querySelector(IMAGE_SOURCES[i][0]);
          for (var a = 1; el && a < IMAGE_SOURCES[i].length; a++) {
            var value = (el.getAttribute(IMAGE_SOURCES[i][a]) || '').trim();
            if (value) return value;
          }
        }
      } catch (e) {}
      return '';
    }

    var jsonLd = [];
    var text = '';
    try {
      var scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (var i = 0; i < scripts.length && jsonLd.length < MAX_BLOCKS; i++) {
        var block = scripts[i].textContent || '';
        if (block.trim() && bytes(block) <= MAX_BLOCK_BYTES) jsonLd.push(block);
      }
      text = cut(document.body ? document.body.innerText || '' : '', MAX_TEXT_BYTES);
    } catch (e) {}
    var imageUrl = pageImage();
    // One too long for the request is left out (''), so it can't make the page unreadable.
    if (imageUrl.length > MAX_IMAGE_URL_LENGTH) imageUrl = '';
    args.completionFunction({ url: document.URL, title: document.title || '', jsonLd: jsonLd, text: text, imageUrl: imageUrl });
  },
  finalize: function () {},
};

var ExtensionPreprocessingJS = new Preprocess();

// Safari runs this in the page before the share sheet opens (NSExtensionJavaScriptPreprocessingFile).
// It hands ShareViewController the page's URL, title, JSON-LD blocks and readable text, so pages
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
    args.completionFunction({ url: document.URL, title: document.title || '', jsonLd: jsonLd, text: text });
  },
  finalize: function () {},
};

var ExtensionPreprocessingJS = new Preprocess();

const URL_ = 'https://www.allrecipes.com/recipe/21014/good-old-fashioned-pancakes/';

Deno.serve(async () => {
  const r = await fetch(URL_, {
    redirect: 'manual',
    headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; ThePerfectBite/1.0; recipe import)' },
  });
  await r.body?.cancel();
  return new Response(`plain fetch ${r.status}`);
});

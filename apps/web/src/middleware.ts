import { defineMiddleware } from 'astro:middleware';
import { funnelForPath, funnelCookie, decodeAnswers } from './lib/funnels';

// Funnel gate: server-rendered pages under a funnel's `gate` paths redirect to /start/<funnel>
// until the visitor has answered it. Prerendered (static) pages are never gated.
export const onRequest = defineMiddleware(async (ctx, next) => {
  if (ctx.isPrerendered) return next();
  const url = ctx.url;
  const f = funnelForPath(url.pathname);
  if (f) {
    const answers = decodeAnswers(ctx.cookies.get(funnelCookie(f.id))?.value);
    if (!answers) {
      const to = `/start/${f.id}?next=${encodeURIComponent(url.pathname + url.search)}`;
      return ctx.redirect(to, 302);
    }
    ctx.locals.funnelAnswers = answers;
  }
  return next();
});

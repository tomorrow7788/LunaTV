#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function loadLocalEnvFile() {
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) return;

  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;

    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    if (quote === '"') {
      value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    process.env[match[1]] = value;
  }
}

loadLocalEnvFile();

const runtimeEnvKeys = [
  'USERNAME', 'PASSWORD', 'NEXT_PUBLIC_STORAGE_TYPE',
  'UPSTASH_URL', 'UPSTASH_TOKEN', 'TMDB_API_KEY',
  'NEXT_PUBLIC_SITE_NAME', 'ANNOUNCEMENT', 'ENABLE_REGISTER',
  'SITE_BASE', 'REDIS_URL', 'KVROCKS_URL',
  'NEXT_PUBLIC_SEARCH_MAX_PAGE',
  'NEXT_PUBLIC_DOUBAN_PROXY_TYPE', 'NEXT_PUBLIC_DOUBAN_PROXY',
  'NEXT_PUBLIC_DOUBAN_IMAGE_PROXY_TYPE', 'NEXT_PUBLIC_DOUBAN_IMAGE_PROXY',
  'NEXT_PUBLIC_DISABLE_YELLOW_FILTER', 'NEXT_PUBLIC_FLUID_SEARCH',
  'NEXT_PUBLIC_BANGUMI_API_TYPE', 'NEXT_PUBLIC_BANGUMI_API_PROXY',
  'NEXT_PUBLIC_BANGUMI_IMAGE_PROXY_TYPE', 'NEXT_PUBLIC_BANGUMI_IMAGE_PROXY',
  'NEXT_PUBLIC_CORSAPI_URL', 'NEXT_PUBLIC_SUB_URL',
  'DISABLE_HERO_TRAILER', 'DISABLE_SSRF_PROTECTION',
  'TVBOX_SUBSCRIBE_TOKEN', 'TRUSTED_NETWORK_IPS',
];

// 跳过认证的路径：静态资源、登录/注册页、公开 API
const skipPaths = [
  '/_next', '/favicon.ico', '/robots.txt', '/manifest.json',
  '/icons/', '/logo.png', '/screenshot.png',
  '/login', '/register', '/oidc-register', '/warning',
  '/api/login', '/api/register', '/api/logout', '/api/cron',
  '/api/server-config', '/api/tvbox', '/api/tvbox-config',
  '/api/live/merged', '/api/parse', '/api/bing-wallpaper',
  '/api/proxy/', '/api/telegram/', '/api/auth/oidc/',
  '/api/watch-room/', '/api/cache/', '/api/client-log',
];

// 用于 layout 注入时过滤掉 API 路径（API 认证由 edge middleware 处理）
const pageSkipPaths = JSON.stringify(skipPaths.filter(p => !p.startsWith('/api/')));

let savedProxyContent = null;
let savedLayoutContent = null;

function getRuntimeEnvLiteral() {
  const env = {};
  for (const key of runtimeEnvKeys) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return JSON.stringify(env);
}

function replaceEnvLiterals(code, envLiteral) {
  let output = '';
  let cursor = 0;
  let replaced = 0;
  const needle = 'env: {';

  while (true) {
    const start = code.indexOf(needle, cursor);
    if (start === -1) {
      output += code.slice(cursor);
      break;
    }

    let i = start + 'env: '.length;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (; i < code.length; i += 1) {
      const char = code[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
    }

    if (depth !== 0) {
      console.warn('[edgeone-build] Unable to replace an env literal: malformed object');
      output += code.slice(cursor);
      break;
    }

    output += code.slice(cursor, start) + `env: ${envLiteral}`;
    cursor = i;
    replaced += 1;
  }

  if (replaced > 0) {
    console.log(`[edgeone-build] Replaced ${replaced} generated env literal(s) with filtered runtime env`);
  }

  return output;
}

function patchEdgeFunctionEnvInjection() {
  const edgeFunctionPath = join(process.cwd(), '.edgeone', 'edge-functions', 'index.js');
  let code;
  try {
    code = readFileSync(edgeFunctionPath, 'utf8');
  } catch {
    return;
  }

  const marker = '/* edgeone-process-env-injected */';
  const envLiteral = getRuntimeEnvLiteral();

  code = replaceEnvLiterals(code, envLiteral);

  const target = 'let request = context.request;';
  if (!code.includes(marker) && !code.includes(target)) {
    console.warn('[edgeone-build] Unable to patch edge function env injection: target not found');
  } else if (!code.includes(marker)) {
    code = code.replace(
      target,
      `${target}\n          ${marker}\n          if (typeof globalThis !== 'undefined' && globalThis.process?.env && context?.env) {\n            Object.assign(globalThis.process.env, context.env);\n          }`
    );
  }

  const middlewareSignature = 'async function executeMiddleware({request}) {';
  const middlewareMarker = '/* edgeone-middleware-env-injected */';
  if (!code.includes(middlewareMarker) && !code.includes(middlewareSignature)) {
    console.warn('[edgeone-build] Unable to patch middleware env injection: target not found');
  } else if (!code.includes(middlewareMarker)) {
    code = code.replace(
      middlewareSignature,
      `async function executeMiddleware({request, env}) {\n  ${middlewareMarker}\n  if (typeof globalThis !== 'undefined' && globalThis.process?.env && env) {\n    Object.assign(globalThis.process.env, env);\n  }`
    );
  }

  writeFileSync(edgeFunctionPath, code);
  console.log('[edgeone-build] Patched edge function process.env injection');
}

function convertProxyToMiddlewareForBuild() {
  const proxyPath = join(process.cwd(), 'src', 'proxy.ts');
  const middlewarePath = join(process.cwd(), 'src', 'middleware.ts');
  const backupPath = join(process.cwd(), 'src', 'proxy.ts.edgeone-backup');

  if (!existsSync(proxyPath) || existsSync(middlewarePath)) return false;

  savedProxyContent = readFileSync(proxyPath, 'utf8');
  let content = savedProxyContent;

  content = content.replace(/export async function proxy\b/, 'export async function middleware');

  content = content.replace(
    /export const config = \{[\s\S]*?matcher[\s\S]*?\};/,
    `export const config = { matcher: ['/', '/:path*'] };`
  );

  const skipPathsLiteral = JSON.stringify(skipPaths);
  const skipInjection = `
  /* edgeone-middleware-skip-paths */
  const __edgeOneSkipPaths = ${skipPathsLiteral};
  if (__edgeOneSkipPaths.some((p) => pathname.startsWith(p))) {
    const __reqHeaders = new Headers(request.headers);
    __reqHeaders.set('x-pathname', pathname);
    return NextResponse.next({ request: { headers: __reqHeaders } });
  }`;

  const destructureRegex = /(const\s*\{\s*pathname\s*\}\s*=\s*request\.nextUrl\s*;)/;
  if (destructureRegex.test(content)) {
    content = content.replace(destructureRegex, `$1${skipInjection}`);
  } else {
    const fallback = `
  /* edgeone-middleware-skip-paths */
  const __edgeOnePathname = request.nextUrl.pathname;
  const __edgeOneSkipPaths = ${skipPathsLiteral};
  if (__edgeOneSkipPaths.some((p) => __edgeOnePathname.startsWith(p))) {
    const __reqHeaders = new Headers(request.headers);
    __reqHeaders.set('x-pathname', __edgeOnePathname);
    return NextResponse.next({ request: { headers: __reqHeaders } });
  }`;
    const fnRegex = /(export\s+async\s+function\s+middleware\s*\([^)]*\)\s*\{)/;
    content = content.replace(fnRegex, `$1${fallback}`);
  }

  renameSync(proxyPath, backupPath);
  writeFileSync(middlewarePath, content);
  console.log('[edgeone-build] Created temporary middleware.ts with skip-paths injection');
  return true;
}

function injectLayoutAuthCheck() {
  const layoutPath = join(process.cwd(), 'src', 'app', 'layout.tsx');
  if (!existsSync(layoutPath)) {
    console.warn('[edgeone-build] layout.tsx not found, skip auth injection');
    return false;
  }

  const original = readFileSync(layoutPath, 'utf8');
  savedLayoutContent = original;

  const marker = '/* edgeone-layout-auth-guard */';
  if (original.includes(marker)) return true;

  const importMarker = "import { cookies } from 'next/headers';";
  if (!original.includes(importMarker)) {
    console.warn('[edgeone-build] Cannot find cookies import in layout.tsx');
    return false;
  }
  let content = original.replace(
    importMarker,
    `${importMarker}\n${marker}\nimport { redirect } from 'next/navigation';\nimport { headers } from 'next/headers';`
  );

  const rootLayoutMarker = 'export default async function RootLayout(';
  const rootLayoutIdx = content.indexOf(rootLayoutMarker);
  if (rootLayoutIdx === -1) {
    console.warn('[edgeone-build] Cannot find RootLayout in layout.tsx');
    return false;
  }

  const cookiesCall = 'await cookies();';
  const idx = content.indexOf(cookiesCall, rootLayoutIdx);
  if (idx === -1) {
    console.warn('[edgeone-build] Cannot find "await cookies()" in RootLayout');
    return false;
  }

  const authCheck = `
  // EdgeOne SSR auth guard (Secure Anti-Bypass Edition)
  const __h = await headers();
  let __path = __h.get('x-pathname') || __h.get('x-invoke-path') || '';
  
  // 1. 尝试解析 EdgeOne / 代理转发的原始路径头
  if (!__path) {
    const __eoUrl = __h.get('x-eo-request-url') || __h.get('x-original-uri') || __h.get('x-original-url') || __h.get('x-forwarded-uri') || '';
    if (__eoUrl) {
      try { __path = new URL(__eoUrl, 'http://localhost').pathname; } catch {}
    }
  }

  // 2. 尝试解析 Next.js RSC 的请求头数据
  if (!__path) {
    const __rscPath = __h.get('x-nextjs-data');
    if (__rscPath) {
      __path = __rscPath.replace('.json', '');
    }
  }

  // 3. 尝试解析来源 Referer
  if (!__path) {
    const __ref = __h.get('referer') || '';
    try { if (__ref) __path = new URL(__ref).pathname; } catch {}
  }
  
  // 4. 精细化安全降级：防御越权 API 请求
  if (!__path) {
     const __accept = __h.get('accept') || '';
     // 如果是页面加载 (HTML)，我们放行交由客户端二次鉴权处理以打破重定向循环
     if (__accept.includes('text/html')) {
         __path = '/login'; 
     } else {
         // 如果是敏感数据预取或 API 调用，强制拦截，阻止数据泄露风险
         __path = '/';
     }
  }

  const __skipPaths = ${pageSkipPaths};
  const __isSkip = __skipPaths.some((p) => {
    if (p === '/login') {
       return __path === '/login' || __path.startsWith('/login?') || __path.startsWith('/login/');
    }
    return __path.startsWith(p);
  });

  if (!__isSkip) {
    const __cookieStore = await cookies();
    const __authCookie = __cookieStore.get('user_auth') || __cookieStore.get('auth');
    if (!__authCookie) {
      if (!__path.includes('login')) {
         const __search = __h.get('x-search') || '';
         redirect('/login?redirect=' + encodeURIComponent(__path + __search));
      }
    }
  }
`;

  const insertPos = idx + cookiesCall.length;
  content = content.slice(0, insertPos) + authCheck + content.slice(insertPos);

  writeFileSync(layoutPath, content);
  console.log('[edgeone-build] Injected Secure SSR auth check into RootLayout in layout.tsx');
  return true;
}

function restoreProxyAfterBuild(wasConverted) {
  if (!wasConverted) return;

  const middlewarePath = join(process.cwd(), 'src', 'middleware.ts');
  const backupPath = join(process.cwd(), 'src', 'proxy.ts.edgeone-backup');

  if (savedProxyContent) {
    writeFileSync(join(process.cwd(), 'src', 'proxy.ts'), savedProxyContent);
    rmSync(middlewarePath, { force: true });
    rmSync(backupPath, { force: true });
    savedProxyContent = null;
    console.log('[edgeone-build] Restored proxy.ts');
    return;
  }

  rmSync(middlewarePath, { force: true });
  if (existsSync(backupPath)) {
    renameSync(backupPath, join(process.cwd(), 'src', 'proxy.ts'));
  }
  console.log('[edgeone-build] Restored proxy.ts from backup');
}

function restoreLayoutAfterBuild() {
  if (!savedLayoutContent) return;
  writeFileSync(join(process.cwd(), 'src', 'app', 'layout.tsx'), savedLayoutContent);
  savedLayoutContent = null;
  console.log('[edgeone-build] Restored layout.tsx');
}

const wasConverted = convertProxyToMiddlewareForBuild();
injectLayoutAuthCheck();

process.on('exit', () => {
  restoreProxyAfterBuild(wasConverted);
  restoreLayoutAfterBuild();
});

const isInsideEdgeOneBuilder = process.env.NEXT_PRIVATE_STANDALONE === 'true';

const command = isInsideEdgeOneBuilder
  ? 'BUILD_TARGET=edgeone EDGEONE_PAGES=1 pnpm build'
  : 'BUILD_TARGET=edgeone EDGEONE_PAGES=1 edgeone makers build';

const child = spawn(command, {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, BUILD_TARGET: 'edgeone', EDGEONE_PAGES: '1' },
});

child.on('exit', (code, signal) => {
  if (!signal && code === 0) {
    for (const file of ['edgeone.json', 'package.json']) {
      copyFileSync(join(process.cwd(), file), join(process.cwd(), '.edgeone', file));
    }

    patchEdgeFunctionEnvInjection();

    for (const envPath of [
      join(process.cwd(), '.edgeone', '.env'),
      join(process.cwd(), '.edgeone', 'cloud-functions', 'ssr-node', '.env'),
    ]) {
      rmSync(envPath, { force: true });
    }
  }

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

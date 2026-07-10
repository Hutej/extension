/**
 * Sanitizer unit tests — pure module import, real logic.
 * Run via: node --experimental-strip-types tests/sanitizer.test.ts
 */

// @ts-ignore - .ts extension needed for node --experimental-strip-types
import { sanitizeCss, sanitizeMarkup } from '../src/core/sanitize/index.ts';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}

// ── CSS Sanitizer Tests ────────────────────────────────────────────

console.log('\n=== sanitizeCss ===\n');

// Test 1: Strip @import
{
  const input = '@import url("https://evil.com/styles.css");\nbody { color: red; }';
  const { css, report } = sanitizeCss(input);
  assert(!css.includes('@import url'), '@import rule stripped');
  assert(css.includes('body { color: red; }'), 'legitimate CSS preserved');
  assert(report.strippedCount === 1, 'report counts 1 strip');
  console.log('  Input:', JSON.stringify(input));
  console.log('  Output:', JSON.stringify(css));
  console.log('  Report:', JSON.stringify(report));
}

// Test 2: Strip expression()
{
  const input = 'div { width: expression(document.body.clientWidth); color: blue; }';
  const { css, report } = sanitizeCss(input);
  assert(!css.includes('expression(document'), 'expression() content stripped');
  assert(css.includes('color: blue'), 'color preserved');
  console.log('  Input:', JSON.stringify(input));
  console.log('  Output:', JSON.stringify(css));
  console.log('  Report:', JSON.stringify(report));
}

// Test 3: Strip javascript: in url()
{
  const input = 'div { background: url("javascript:alert(1)"); }';
  const { css, report } = sanitizeCss(input);
  assert(!css.includes('javascript:'), 'javascript: stripped');
  assert(report.strippedCount >= 1, 'report counts strip');
  console.log('  Input:', JSON.stringify(input));
  console.log('  Output:', JSON.stringify(css));
  console.log('  Report:', JSON.stringify(report));
}

// Test 4: Strip -moz-binding
{
  const input = 'div { -moz-binding: url("https://evil.com/xbl"); color: green; }';
  const { css, report } = sanitizeCss(input);
  assert(!css.includes('-moz-binding: url'), '-moz-binding property stripped');
  assert(css.includes('color: green'), 'color preserved');
  console.log('  Input:', JSON.stringify(input));
  console.log('  Output:', JSON.stringify(css));
  console.log('  Report:', JSON.stringify(report));
}

// Test 5: Strip behavior: url()
{
  const input = 'div { behavior: url("htc/menu.htc"); font-size: 14px; }';
  const { css, report } = sanitizeCss(input);
  assert(!css.includes('behavior:'), 'behavior stripped');
  assert(css.includes('font-size: 14px'), 'font-size preserved');
  console.log('  Input:', JSON.stringify(input));
  console.log('  Output:', JSON.stringify(css));
  console.log('  Report:', JSON.stringify(report));
}

// Test 6: Preserve legitimate advanced CSS
{
  const input = `
.card {
  backdrop-filter: blur(10px);
  box-shadow: 0 4px 6px rgba(0,0,0,0.3);
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  transform: rotate(45deg) scale(1.2);
  border-radius: 12px;
}
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
`;
  const { css, report } = sanitizeCss(input);
  assert(css.includes('backdrop-filter: blur(10px)'), 'backdrop-filter preserved');
  assert(css.includes('box-shadow:'), 'box-shadow preserved');
  assert(css.includes('linear-gradient'), 'gradient preserved');
  assert(css.includes('@keyframes fadeIn'), '@keyframes preserved');
  assert(css.includes('transform:'), 'transform preserved');
  assert(report.strippedCount === 0, 'nothing stripped from legitimate CSS');
  console.log('  Report:', JSON.stringify(report));
}

// Test 7: Strip external url() but keep data: and https:
{
  const input = `
.bg1 { background: url("data:image/png;base64,abc123"); }
.bg2 { background: url("https://cdn.example.com/image.png"); }
.bg3 { background: url("http://evil.com/tracker.gif"); }
.bg4 { background: url("ftp://files.evil.com/data"); }
`;
  const { css, report } = sanitizeCss(input);
  assert(css.includes('data:image/png'), 'data: URL preserved');
  assert(css.includes('https://cdn.example.com'), 'https: URL preserved');
  assert(!css.includes('http://evil.com'), 'http: URL stripped');
  assert(!css.includes('ftp://'), 'ftp: URL stripped');
  assert(report.strippedCount === 2, '2 unsafe URLs stripped');
  console.log('  Report:', JSON.stringify(report));
}

// ── HTML Sanitizer Tests ───────────────────────────────────────────

console.log('\n=== sanitizeMarkup ===\n');

// Test 8: Strip <script> tags
{
  const input = '<div>Hello</div><script>alert("xss")</script><p>World</p>';
  const { html, report } = sanitizeMarkup(input);
  assert(!html.includes('<script'), '<script> stripped');
  assert(!html.includes('alert'), 'script content stripped');
  assert(html.includes('<div>Hello</div>'), 'div preserved');
  assert(html.includes('<p>World</p>'), 'p preserved');
  console.log('  Input:', JSON.stringify(input));
  console.log('  Output:', JSON.stringify(html));
  console.log('  Report:', JSON.stringify(report));
}

// Test 9: Strip on* handlers
{
  const input = '<button onclick="alert(1)" class="btn">Click</button>';
  const { html, report } = sanitizeMarkup(input);
  assert(!html.includes('onclick'), 'onclick stripped');
  assert(html.includes('class="btn"'), 'class preserved');
  assert(html.includes('>Click</button>'), 'content preserved');
  console.log('  Input:', JSON.stringify(input));
  console.log('  Output:', JSON.stringify(html));
  console.log('  Report:', JSON.stringify(report));
}

// Test 10: Strip <iframe>, <object>, <embed>
{
  const input = '<div><iframe src="https://evil.com"></iframe><object data="x.swf"></object><embed src="y.swf"><p>Safe</p></div>';
  const { html, report } = sanitizeMarkup(input);
  assert(!html.includes('<iframe'), '<iframe> stripped');
  assert(!html.includes('<object'), '<object> stripped');
  assert(!html.includes('<embed'), '<embed> stripped');
  assert(html.includes('<p>Safe</p>'), 'safe content preserved');
  console.log('  Input:', JSON.stringify(input));
  console.log('  Output:', JSON.stringify(html));
  console.log('  Report:', JSON.stringify(report));
}

// Test 11: Strip javascript: URLs in href
{
  const input = '<a href="javascript:void(0)">Click</a><a href="https://safe.com">Safe</a>';
  const { html, report } = sanitizeMarkup(input);
  assert(!html.includes('javascript:'), 'javascript: href stripped');
  assert(html.includes('https://safe.com'), 'safe href preserved');
  console.log('  Input:', JSON.stringify(input));
  console.log('  Output:', JSON.stringify(html));
  console.log('  Report:', JSON.stringify(report));
}

// Test 12: Preserve benign markup
{
  const input = '<div class="container"><h1>Title</h1><p>Some <strong>bold</strong> text</p><img src="https://example.com/photo.jpg" alt="Photo"></div>';
  const { html, report } = sanitizeMarkup(input);
  assert(html.includes('<h1>Title</h1>'), 'h1 preserved');
  assert(html.includes('<strong>bold</strong>'), 'strong preserved');
  assert(html.includes('src="https://example.com/photo.jpg"'), 'img src preserved');
  assert(html.includes('alt="Photo"'), 'alt preserved');
  assert(report.strippedCount === 0, 'nothing stripped from benign markup');
  console.log('  Report:', JSON.stringify(report));
}

// Test 13: Multiple on* handlers on one tag
{
  const input = '<img onerror="alert(1)" onload="track()" src="https://safe.com/img.png" alt="test">';
  const { html, report } = sanitizeMarkup(input);
  assert(!html.includes('onerror'), 'onerror stripped');
  assert(!html.includes('onload'), 'onload stripped');
  assert(html.includes('src="https://safe.com/img.png"'), 'src preserved');
  assert(html.includes('alt="test"'), 'alt preserved');
  console.log('  Input:', JSON.stringify(input));
  console.log('  Output:', JSON.stringify(html));
  console.log('  Report:', JSON.stringify(report));
}

// ── Summary ────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All sanitizer tests passed!');
}

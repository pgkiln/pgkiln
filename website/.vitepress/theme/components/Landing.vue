<script setup lang="ts">
import { ref } from 'vue';

const shots = [
  { key: 'designer', label: 'Page designer', src: '/images/builder-page-designer.png', alt: 'The page designer with component tree, layout and property editor', caption: 'Drag regions, items and buttons into place; every property in one editor.' },
  { key: 'dashboard', label: 'Dashboard', src: '/images/app-dashboard.png', alt: 'An application dashboard with metric cards and charts', caption: 'Metric cards and charts, each one a SQL query.' },
  { key: 'report', label: 'Interactive report', src: '/images/app-interactive-report.png', alt: 'An interactive report with search and filters', caption: 'Search, filter, sort and download, without writing UI code.' },
  { key: 'search', label: 'Faceted search', src: '/images/app-faceted-search.png', alt: 'Smart filters and faceted search over a table', caption: 'Smart filters and facets, counted by the database.' },
  { key: 'map', label: 'Maps and cards', src: '/images/app-cards-map.png', alt: 'A map region and a cards region', caption: 'Maps on OpenStreetMap and cards on the same table.' },
  { key: 'dark', label: 'Dark mode', src: '/images/app-charts-dark.png', alt: 'Charts in dark mode', caption: 'Light and dark, and a Theme Roller for your colours.' },
  { key: 'sql', label: 'SQL Workshop', src: '/images/builder-object-browser.png', alt: 'The SQL Workshop object browser', caption: 'An object browser with RLS policies and grants, SQL commands and scripts.' },
];
const active = ref(shots[0].key);

const features = [
  { icon: '🧱', title: 'Apps are data', text: 'Pages, regions, items, validations and processes are rows in a meta schema. Export them, diff them in git, import them in one transaction.' },
  { icon: '⚡', title: 'Generated from your tables', text: 'Point a wizard at a table and get a report and form, a grid, cards, a calendar, a chart, a map or a faceted search, with defaults from the catalog.' },
  { icon: '🛡️', title: 'Secure by default', text: 'A least-privilege runtime role, a database role per app, row level security, checksummed URLs, CSRF protection and a strict CSP.' },
  { icon: '🐘', title: 'Your logic stays in PostgreSQL', text: 'Business rules live in PL/pgSQL. Raise an exception and the message appears on the right form field.' },
  { icon: '🔐', title: 'Sign-in your way', text: 'Built-in accounts with roles, OpenID Connect, SAML 2.0, LDAP, HTTP headers or database accounts, and authorization schemes.' },
  { icon: '📱', title: 'Phone, tablet and desktop', text: 'Responsive pages, installable as a Progressive Web App, with offline pages and forms sent when the network is back.' },
  { icon: '🔌', title: 'REST in and out', text: 'REST modules and OAuth clients for your API, PostgREST alongside, and regions and lists of values on other web services.' },
  { icon: '🧩', title: 'Extend it', text: 'Template components and plug-ins with their own JavaScript, CSS and PL/pgSQL, packed in one file.' },
  { icon: '🤖', title: 'AI where it helps', text: 'AI assistants in your apps with Claude or OpenAI, and an MCP server so coding agents can read and change your apps.' },
];

const steps = [
  { n: '1', title: 'Point it at your tables', text: 'Install pgkiln next to your schemas (or in its own database). It adds one schema, meta, and a few roles; nothing else changes.' },
  { n: '2', title: 'Generate the pages', text: 'Create an application from existing tables, a spreadsheet or pasted data. You get reports, forms, navigation and a dashboard.' },
  { n: '3', title: 'Shape it in SQL', text: 'Refine pages in the designer, write queries and PL/pgSQL, add security, translations and documents. Deploy with one command.' },
];

const faqs = [
  { q: 'Is pgkiln free?', a: 'Yes. pgkiln is open source under the Apache-2.0 license. You host it yourself; there are no paid tiers or usage limits.' },
  { q: 'How does it compare with Oracle APEX?', a: 'pgkiln follows APEX’s model (apps as metadata, pages with regions and items, page processing in SQL) on PostgreSQL. The parity matrix compares 137 APEX features: most are available, and what is partial or missing is listed honestly.' },
  { q: 'What do I need to run it?', a: 'PostgreSQL 15 or newer and Node.js 20 or newer, or just Docker: the compose file starts PostgreSQL 17 and pgkiln together. There is no separate web listener like ORDS.' },
  { q: 'How big a server do I need?', a: 'Small. To try it out or for a small team: 1 CPU core, 1 GB of memory and 5 GB of disk. In production for up to a few hundred users: 2 cores, 2\u20134 GB and 20 GB plus your data. In our test one pgkiln process served about 240 pages per second on a single core.', link: { href: '/docs/installation#hardware', text: 'Requirements and measurements' } },
  { q: 'Can I keep my applications in git?', a: 'Yes. The command line exports an application as one readable file per component (JSON or YAML with the SQL inline), shows a diff against the database and updates an application in place.' },
  { q: 'Does it lock me in?', a: 'Your data stays in your own PostgreSQL tables with your own constraints and policies. pgkiln only adds its meta schema, and an application is a JSON document you can read.' },
];
</script>

<template>
  <div class="pk">
    <!-- hero -->
    <section class="hero">
      <div class="wrap hero-grid">
        <div class="hero-text">
          <p class="eyebrow">Open source · PostgreSQL · Apache-2.0</p>
          <h1>Build database apps on PostgreSQL. <span class="grad">In SQL.</span></h1>
          <p class="lead">
            pgkiln is a low-code application builder for PostgreSQL, modeled on Oracle APEX. Generate reports, forms,
            dashboards and maps from your tables, keep your rules in PL/pgSQL, and ship secure web apps your team can run.
          </p>
          <div class="actions">
            <a class="btn primary" href="/docs/installation">Get started</a>
            <a class="btn" href="/docs/tutorial">Follow the tutorial</a>
            <a class="btn ghost" href="https://github.com/pgkiln/pgkiln">GitHub</a>
          </div>
          <pre class="install"><code><span class="c"># with Docker: PostgreSQL 17 + pgkiln</span>
cd deploy &amp;&amp; cp .env.example .env   <span class="c"># fill in four secrets</span>
docker compose up -d   <span class="c"># → http://127.0.0.1:3100/builder</span></code></pre>
        </div>
        <div class="hero-shot">
          <img src="/images/builder-page-designer.png" alt="The pgkiln page designer" width="1440" height="900" />
        </div>
      </div>
    </section>

    <!-- strip -->
    <section class="strip">
      <div class="wrap strip-row">
        <span><b>137</b> APEX features compared</span>
        <span><b>20</b> region types</span>
        <span><b>22</b> built-in languages</span>
        <span><b>1</b> schema added to your database</span>
        <span><b>0</b> licence fees</span>
      </div>
    </section>

    <!-- features -->
    <section id="features" class="section">
      <div class="wrap">
        <h2>Everything a database app needs</h2>
        <p class="sub">The parts you would otherwise build by hand, ready on day one and driven by SQL.</p>
        <div class="grid3">
          <article v-for="f in features" :key="f.title" class="card">
            <div class="icon" aria-hidden="true">{{ f.icon }}</div>
            <h3>{{ f.title }}</h3>
            <p>{{ f.text }}</p>
          </article>
        </div>
      </div>
    </section>

    <!-- screenshots -->
    <section class="section alt">
      <div class="wrap">
        <h2>See it in action</h2>
        <p class="sub">The HR example application that ships with pgkiln, and the builder.</p>
        <div class="tabs" role="tablist" aria-label="Screenshots">
          <button
            v-for="s in shots" :key="s.key" role="tab" type="button"
            :aria-selected="active === s.key" :class="{ on: active === s.key }" @click="active = s.key"
          >{{ s.label }}</button>
        </div>
        <template v-for="s in shots" :key="s.key">
          <figure v-show="active === s.key" class="shot" role="tabpanel">
            <img :src="s.src" :alt="s.alt" width="1440" height="900" loading="lazy" />
            <figcaption>{{ s.caption }}</figcaption>
          </figure>
        </template>
      </div>
    </section>

    <!-- how it works -->
    <section class="section">
      <div class="wrap">
        <h2>From table to app in three steps</h2>
        <div class="steps">
          <div v-for="s in steps" :key="s.n" class="step">
            <span class="n">{{ s.n }}</span>
            <h3>{{ s.title }}</h3>
            <p>{{ s.text }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- code -->
    <section class="section alt">
      <div class="wrap split">
        <div>
          <h2>Your rules, in the database</h2>
          <p class="sub left">
            A region is a query. A validation is a PL/pgSQL function. Bind variables work the way APEX developers expect,
            and an exception lands on the form field it is about.
          </p>
          <ul class="ticks">
            <li><code>:P3_DEPTNO</code> bind variables, <code>meta.v()</code> inside functions</li>
            <li>Row level security with <code>meta.app_user()</code> and <code>meta.has_role()</code></li>
            <li>Triggers, audit trails and approvals in plain PostgreSQL</li>
          </ul>
          <a class="more" href="/docs/concepts">How pgkiln works →</a>
        </div>
        <pre class="code"><code><span class="c">-- a report region's source</span>
<span class="k">select</span> e.empno, e.ename, e.job, d.dname
  <span class="k">from</span> sales.emp e <span class="k">join</span> sales.dept d <span class="k">using</span> (deptno)
 <span class="k">where</span> :P2_DEPTNO <span class="k">is null or</span> e.deptno = :P2_DEPTNO;

<span class="c">-- a rule the Save button runs</span>
<span class="k">create function</span> sales.check_discount(p numeric)
<span class="k">returns void language</span> plpgsql <span class="k">as</span> $$
<span class="k">begin</span>
  <span class="k">if</span> p &gt; 0.2 <span class="k">and not</span> meta.has_role(<span class="s">'manager'</span>) <span class="k">then</span>
    <span class="k">raise exception</span> <span class="s">'Discounts over 20% need a manager'</span>
      <span class="k">using</span> column = <span class="s">'discount'</span>;
  <span class="k">end if</span>;
<span class="k">end</span> $$;</code></pre>
      </div>
    </section>

    <!-- AI + git -->
    <section class="section">
      <div class="wrap grid2">
        <article class="card big">
          <p class="eyebrow">For your git workflow</p>
          <h3>Applications as files</h3>
          <p>Export an app as one file per component, review the diff in a pull request, and deploy with
            <code>pgkiln import --replace</code>: one transaction, users and saved reports kept.</p>
          <a class="more" href="/docs/cli">The command line →</a>
        </article>
        <article class="card big">
          <p class="eyebrow">For AI coding agents</p>
          <h3>An MCP server built in</h3>
          <p>Claude Code, Cursor and other agents can list your apps, explain a page, look at the tables behind it,
            and change the app through files with a diff before anything is imported. Queries are read-only.</p>
          <a class="more" href="/docs/ai-agents">AI coding agents →</a>
        </article>
      </div>
    </section>

    <!-- APEX -->
    <section class="section alt">
      <div class="wrap split">
        <div>
          <p class="eyebrow">Coming from Oracle APEX?</p>
          <h2>The model you know, on PostgreSQL</h2>
          <p class="sub left">
            Pages, regions, items, dynamic actions, shared components, authorization schemes, the page designer and the
            SQL Workshop all work the way you expect. The guide maps every concept and shows how to port PL/SQL.
          </p>
          <div class="actions">
            <a class="btn primary" href="/docs/from-apex">Guide for APEX developers</a>
            <a class="btn" href="/docs/apex-parity">Feature parity</a>
          </div>
        </div>
        <img class="phone" src="/images/app-phone.png" alt="An application on a phone" width="390" height="844" loading="lazy" />
      </div>
    </section>

    <!-- pricing -->
    <section class="section">
      <div class="wrap">
        <h2>Pricing</h2>
        <p class="sub">One plan, and it is the whole thing.</p>
        <div class="price">
          <div>
            <p class="eyebrow">Community</p>
            <p class="amount">Free <span>forever, self-hosted</span></p>
            <ul class="ticks">
              <li>Every feature, no user or app limits</li>
              <li>Apache-2.0: use it commercially, change it</li>
              <li>Your data never leaves your PostgreSQL</li>
              <li>Docker image and compose file included</li>
            </ul>
          </div>
          <a class="btn primary" href="/docs/installation">Install pgkiln</a>
        </div>
      </div>
    </section>

    <!-- faq -->
    <section class="section alt">
      <div class="wrap narrow">
        <h2>Questions</h2>
        <details v-for="f in faqs" :key="f.q" class="faq">
          <summary>{{ f.q }}</summary>
          <p>{{ f.a }} <a v-if="f.link" class="more inline" :href="f.link.href">{{ f.link.text }} →</a></p>
        </details>
      </div>
    </section>

    <!-- cta -->
    <section class="cta">
      <div class="wrap">
        <h2>Build your first app this afternoon</h2>
        <p>Install with Docker, open the builder and create an application from a table.</p>
        <div class="actions center">
          <a class="btn primary" href="/docs/installation">Get started</a>
          <a class="btn ghost light" href="https://github.com/pgkiln/pgkiln">Star on GitHub</a>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.pk { --gutter: 24px; color: var(--vp-c-text-1); }
.wrap { max-width: 1200px; margin: 0 auto; padding: 0 var(--gutter); }
.narrow { max-width: 760px; }
h1 { font-size: clamp(2rem, 3.6vw, 3rem); line-height: 1.08; font-weight: 800; letter-spacing: -0.02em; margin: 0 0 20px; }
h2 { font-size: clamp(1.6rem, 3vw, 2.3rem); line-height: 1.2; font-weight: 750; letter-spacing: -0.01em; margin: 0 0 12px; text-align: center; border: 0; padding: 0; }
.split h2, .grid2 h3 { text-align: left; }
h3 { font-size: 1.1rem; font-weight: 650; margin: 0 0 8px; }
p { margin: 0; line-height: 1.65; }
.grad { background: var(--vp-home-hero-name-background); -webkit-background-clip: text; background-clip: text; color: transparent; }
.eyebrow { font-size: 0.8rem; font-weight: 650; text-transform: uppercase; letter-spacing: 0.08em; color: var(--vp-c-brand-1); margin-bottom: 12px; }
.lead { font-size: 1.15rem; color: var(--pk-muted); max-width: 40rem; }
.sub { color: var(--pk-muted); text-align: center; max-width: 44rem; margin: 0 auto 40px; font-size: 1.05rem; }
.sub.left { text-align: left; margin: 0 0 20px; }
code { font-size: 0.88em; }

.hero { padding: 64px 0 48px; background: radial-gradient(1200px 500px at 85% -10%, var(--vp-c-brand-soft), transparent 70%); }
.hero-grid > *, .split > *, .grid2 > *, .grid3 > * { min-width: 0; }
.hero-grid { display: grid; grid-template-columns: 1fr 1.15fr; gap: 48px; align-items: center; }
.hero-shot img { width: 100%; height: auto; border-radius: 12px; border: 1px solid var(--pk-border); box-shadow: 0 30px 60px -20px rgba(0, 0, 0, 0.35); }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin: 28px 0; }
.actions.center { justify-content: center; }
.btn { display: inline-flex; align-items: center; padding: 10px 20px; border-radius: 999px; font-weight: 600; font-size: 0.95rem; border: 1px solid var(--pk-border); color: var(--vp-c-text-1); background: var(--vp-c-bg); text-decoration: none; transition: border-color 0.15s, background 0.15s; }
.btn:hover { border-color: var(--vp-c-brand-1); }
.btn.primary { background: var(--vp-button-brand-bg); border-color: var(--vp-button-brand-bg); color: #fff; }
.btn.primary:hover { background: var(--vp-button-brand-hover-bg); }
.btn.ghost { background: transparent; }
.btn.light { color: #fff; border-color: rgba(255, 255, 255, 0.4); }
.install { background: var(--pk-code-bg); color: #e7e5e4; border-radius: 10px; padding: 16px 18px; font-size: 0.85rem; line-height: 1.6; overflow-x: auto; margin: 0; }
.c { color: #a8a29e; } .k { color: #fb923c; } .s { color: #86efac; }

.strip { border-block: 1px solid var(--pk-border); background: var(--pk-surface); }
.strip-row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px 28px; padding-block: 18px; color: var(--pk-muted); font-size: 0.95rem; }
.strip b { color: var(--vp-c-text-1); font-size: 1.15rem; margin-right: 4px; }

.section { padding: 88px 0; }
.section.alt { background: var(--pk-surface); }
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.card { background: var(--vp-c-bg); border: 1px solid var(--pk-border); border-radius: 14px; padding: 24px; }
.card p { color: var(--pk-muted); font-size: 0.95rem; }
.card.big { padding: 32px; }
.card.big h3 { font-size: 1.4rem; }
.icon { font-size: 1.5rem; width: 44px; height: 44px; display: grid; place-items: center; border-radius: 10px; background: var(--vp-c-brand-soft); margin-bottom: 14px; }
.more.inline { margin-top: 0; }
.more { display: inline-block; margin-top: 16px; font-weight: 600; color: var(--vp-c-brand-1); text-decoration: none; }

.tabs { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-bottom: 24px; }
.tabs button { padding: 8px 16px; border-radius: 999px; border: 1px solid var(--pk-border); background: var(--vp-c-bg); color: var(--pk-muted); font-weight: 600; font-size: 0.9rem; cursor: pointer; }
.tabs button.on { background: var(--vp-c-brand-soft); border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }
.shot { margin: 0; }
.shot img { width: 100%; height: auto; border-radius: 12px; border: 1px solid var(--pk-border); box-shadow: 0 20px 50px -25px rgba(0, 0, 0, 0.35); }
.shot figcaption { text-align: center; color: var(--pk-muted); margin-top: 14px; }

.steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px; margin-top: 40px; }
.step .n { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: var(--vp-button-brand-bg); color: #fff; font-weight: 700; margin-bottom: 16px; }
.step p { color: var(--pk-muted); }

.split { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; align-items: center; }
.code { background: var(--pk-code-bg); color: #e7e5e4; border-radius: 12px; padding: 22px; font-size: 0.84rem; line-height: 1.65; overflow-x: auto; margin: 0; }
.ticks { list-style: none; padding: 0; margin: 0; }
.ticks li { position: relative; padding-left: 26px; margin: 10px 0; color: var(--pk-muted); }
.ticks li::before { content: '✓'; position: absolute; left: 0; color: var(--vp-c-brand-1); font-weight: 700; }
.phone { justify-self: center; width: min(300px, 70%); height: auto; border-radius: 28px; border: 8px solid #1c1917; box-shadow: 0 30px 60px -25px rgba(0, 0, 0, 0.45); }

.price { max-width: 640px; margin: 0 auto; display: flex; flex-wrap: wrap; gap: 24px; justify-content: space-between; align-items: center; border: 2px solid var(--vp-c-brand-1); border-radius: 16px; padding: 32px; background: var(--vp-c-bg); }
.amount { font-size: 2.4rem; font-weight: 800; margin-bottom: 12px; }
.amount span { font-size: 1rem; font-weight: 500; color: var(--pk-muted); }

.faq { border-bottom: 1px solid var(--pk-border); padding: 18px 0; }
.faq summary { cursor: pointer; font-weight: 650; font-size: 1.05rem; list-style: none; display: flex; justify-content: space-between; gap: 16px; }
.faq summary::after { content: '+'; color: var(--vp-c-brand-1); font-size: 1.3rem; line-height: 1; }
.faq[open] summary::after { content: '−'; }
.faq p { color: var(--pk-muted); margin-top: 10px; }

.cta { padding: 88px 0; text-align: center; background: linear-gradient(135deg, #7c2d12, #c2410c 60%, #ea580c); color: #fff; }
.cta h2 { color: #fff; }
.cta p { color: rgba(255, 255, 255, 0.85); font-size: 1.1rem; }

@media (max-width: 960px) {
  .hero-grid, .split, .grid2 { grid-template-columns: 1fr; }
  .grid3 { grid-template-columns: 1fr 1fr; }
  .steps { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .pk { --gutter: 16px; }
  .hero { padding-top: 40px; }
  .grid3 { grid-template-columns: 1fr; }
  .section, .cta { padding: 56px 0; }
  .strip-row { justify-content: flex-start; }
  .price { padding: 24px; }
}
</style>

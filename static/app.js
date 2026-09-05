// UI state and API calls. Every mutation posts to the admin API, which writes
// straight through to the TOML config file — there is no separate "apply" step.

// The whole app (UI + API + /v1 + /mcp) is served under one `path_prefix`, so
// the API lives beside the page that loaded: strip the document name off the
// current path and everything else is relative to that. Deriving it from the
// URL rather than from config means the page works at any prefix without a
// rebuild, and keeps working if the prefix changes.
const API = location.pathname.replace(/\/[^/]*$/, '');

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return body;
}

function gateway() {
  return {
    tab: 'status',
    configFilter: 'groups', // 'groups' | 'upstreams'
    status: {},
    upstreams: [],
    groups: [],
    logs: [],
    logFilters: { entry_model: '', upstream_model: '', status: '', from: '', to: '' },
    logPage: 1,
    logPageSize: 50,
    logTotal: 0,
    logTotalPages: 0,
    logStatuses: [],
    logErrorKinds: [],
    msg: '',
    msgKind: 'ok',
    autoRefresh: false,
    /** The gateway's timezone; every rendered time is read against it. */
    clock: {},

    async init() {
      const savedPageSize = Number(localStorage.getItem('logs.pageSize'));
      if ([10, 20, 50, 100, 200].includes(savedPageSize)) this.logPageSize = savedPageSize;
      this.readRoute();
      window.addEventListener('popstate', () => { this.readRoute(); if (this.tab === 'logs') this.loadLogs(); });
      // Fetch first: the <local-time> elements below need the zone before the
      // first row renders, or they would briefly show the wrong clock.
      await this.loadRuntime();
      await this.loadAll();
      setInterval(() => {
        if (this.autoRefresh && this.tab === 'status') this.loadStatus();
      }, 5000);
    },

    readRoute() {
      const query = new URLSearchParams(location.search);
      const tab = query.get('tab');
      const section = query.get('section');
      this.tab = ['status', 'config', 'logs'].includes(tab) ? tab : 'status';
      this.configFilter = ['groups', 'upstreams'].includes(section) ? section : 'groups';
      if (this.tab === 'logs') {
        this.logFilters.entry_model = query.get('entry_model') || '';
        this.logFilters.upstream_model = query.get('upstream_model') || '';
        this.logFilters.status = query.get('status') || '';
        this.logFilters.from = this.isoToLocalInput(query.get('from'));
        this.logFilters.to = this.isoToLocalInput(query.get('to'));
        this.logPage = Math.max(1, Number(query.get('page')) || 1);
      }
    },

    navigateTab(tab) {
      this.tab = tab;
      this.writeRoute();
    },

    navigateConfig(section) {
      this.tab = 'config';
      this.configFilter = section;
      this.writeRoute();
    },

    writeRoute() {
      const url = new URL(location.href);
      url.searchParams.set('tab', this.tab);
      if (this.tab === 'config') url.searchParams.set('section', this.configFilter);
      else url.searchParams.delete('section');
      for (const key of ['entry_model', 'upstream_model', 'status', 'from', 'to', 'page']) url.searchParams.delete(key);
      if (this.tab === 'logs') {
        const values = {
          entry_model: this.logFilters.entry_model,
          upstream_model: this.logFilters.upstream_model,
          status: this.logFilters.status,
          from: this.localInputToIso(this.logFilters.from),
          to: this.localInputToIso(this.logFilters.to),
          page: this.logPage > 1 ? this.logPage : '',
        };
        Object.entries(values).forEach(([key, value]) => { if (value) url.searchParams.set(key, value); });
      }
      url.hash = '';
      history.pushState(null, '', url);
    },

    upstreamAnchor(id) {
      return `upstream-${encodeURIComponent(id).replaceAll('%', '_')}`;
    },

    endpointUrl() {
      const url = new URL(`${API || ''}/v1/chat/completions`, location.origin);
      return url.href;
    },

    async loadAll() {
      await Promise.all([this.loadStatus(), this.loadConfig(), this.loadLogs()]);
    },

    notify(text, kind = 'ok') {
      this.msg = text;
      this.msgKind = kind;
      setTimeout(() => { if (this.msg === text) this.msg = ''; }, 4000);
    },

    async copyText(value) {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
        } else {
          const input = document.createElement('textarea');
          input.value = value;
          input.style.position = 'fixed';
          input.style.opacity = '0';
          document.body.appendChild(input);
          input.select();
          const copied = document.execCommand('copy');
          input.remove();
          if (!copied) throw new Error('copy command failed');
        }
        this.notify(`已复制 ${value}`);
      } catch (_) {
        this.notify('复制失败，请手动复制', 'error');
      }
    },

    async copyEntryModel(name) {
      return this.copyText(name);
    },

    async guard(fn, okMsg) {
      try {
        const r = await fn();
        if (okMsg) this.notify(okMsg);
        return r;
      } catch (e) {
        this.notify(e.message, 'error');
        throw e;
      }
    },

    async loadRuntime() {
      try {
        const r = await api('/api/runtime');
        this.clock = r.clock || {};
        window.gatewayClock?.set(this.clock);
      } catch (e) {
        this.notify(e.message, 'error');
      }
    },

    async loadStatus() {
      try {
        this.status = await api('/api/status');
        if (this.status.clock) {
          this.clock = this.status.clock;
          window.gatewayClock?.set(this.clock);
        }
      } catch (e) { this.notify(e.message, 'error'); }
    },

    async loadConfig() {
      try {
        const cfg = await api('/api/config');
        // Normalise so the form can bind to fields the TOML may omit.
        this.upstreams = (cfg.upstreams || []).map(u => ({
          ...u,
          // The API omits default-true fields, so absence means enabled.
          enabled: u.enabled !== false,
          limits: (u.limits || []).map(l => ({
            ...l,
            backoff: l.backoff || { type: 'exponential', start: '60s', max: '24h' },
            // `<input type="time">` needs zero-padded HH:MM, but the config may
            // legitimately hold `8:00`.
            forbidden: (l.forbidden || []).map(w => ({
              start: padTime(w.start),
              end: padTime(w.end),
            })),
            days: l.days || [],
          })),
        }));
        this.groups = (cfg.groups || []).map(g => ({
          ...g,
          routes: (g.routes || []).map(r => ({
            ...r,
            // Route.enabled has the same default-true wire representation.
            enabled: r.enabled !== false,
          })),
        }));
        // Hash targets are rendered only after this async config fetch.
        if (location.hash) requestAnimationFrame(() => this.scrollToHash());
      } catch (e) { this.notify(e.message, 'error'); }
    },

    scrollToHash() {
      const id = decodeURIComponent(location.hash.slice(1));
      document.getElementById(id)?.scrollIntoView();
    },

    async loadLogs() {
      const q = new URLSearchParams({ page: this.logPage, page_size: this.logPageSize });
      const selectedStatus = String(this.logFilters.status || '');
      const values = {
        entry_model: this.logFilters.entry_model,
        upstream_model: this.logFilters.upstream_model,
        status: /^\d+$/.test(selectedStatus) ? selectedStatus : '',
        error_kind: selectedStatus.startsWith('error:') ? selectedStatus.slice(6) : '',
        from: this.localInputToIso(this.logFilters.from),
        to: this.localInputToIso(this.logFilters.to),
      };
      Object.entries(values).forEach(([key, value]) => { if (value) q.set(key, value); });
      try {
        const r = await api('/api/logs?' + q);
        this.logs = r.items || [];
        this.logPage = r.page || 1;
        this.logTotal = r.total || 0;
        this.logTotalPages = r.total_pages || 0;
        this.logStatuses = r.statuses || [];
        this.logErrorKinds = r.error_kinds || [];
      } catch (e) { this.notify(e.message, 'error'); }
    },

    async applyLogFilters() {
      this.logPage = 1;
      this.writeRoute();
      await this.loadLogs();
    },

    async setLogRange(hours) {
      const now = new Date();
      this.logFilters.from = this.dateToLocalInput(new Date(now.getTime() - hours * 3600000));
      this.logFilters.to = this.dateToLocalInput(now);
      await this.applyLogFilters();
    },

    async changeLogPage(delta) {
      await this.goToLogPage(this.logPage + delta);
    },

    async goToLogPage(next) {
      if (next < 1 || next > this.logTotalPages) return;
      this.logPage = next;
      this.writeRoute();
      await this.loadLogs();
    },

    logPaginationItems() {
      const end = this.logTotalPages;
      if (end <= 7) return Array.from({ length: end }, (_, i) => i + 1);
      const pages = new Set([1, 2, 3, end, this.logPage - 1, this.logPage, this.logPage + 1]);
      const sorted = [...pages].filter(p => p >= 1 && p <= end).sort((a, b) => a - b);
      const items = [];
      sorted.forEach((page, index) => {
        if (index && page - sorted[index - 1] > 1) items.push(`ellipsis-${page}`);
        items.push(page);
      });
      return items;
    },

    async changeLogPageSize() {
      localStorage.setItem('logs.pageSize', String(this.logPageSize));
      await this.applyLogFilters();
    },

    localInputToIso(value) { return value ? new Date(value).toISOString() : ''; },
    isoToLocalInput(value) { return value ? this.dateToLocalInput(new Date(value)) : ''; },
    dateToLocalInput(date) {
      const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
      return local.toISOString().slice(0, 16);
    },

    // --- upstreams ---

    newUpstream() {
      const model = prompt('新上游模型名（唯一标识）：');
      if (!model) return;
      this.guard(async () => {
        await api('/api/upstreams', {
          method: 'POST',
          body: JSON.stringify({ model, enabled: true, limits: [] }),
        });
        await this.loadConfig();
      }, `已新增上游 ${model}`);
    },

    async saveUpstream(u) {
      // Strip empty optional fields so they are omitted from the TOML rather
      // than written as nulls.
      const limits = u.limits.map(l => {
        const out = { ...l };
        // Quota periods always align to gateway-local 00:00.
        delete out.anchor;
        if (out.type !== 'tokens') delete out.weight;
        if (out.type === 'tokens' && !out.weight) delete out.weight;
        if (out.type !== 'error_backoff') delete out.backoff;
        if (out.type === 'error_backoff') {
          delete out.count; delete out.period; delete out.anchor;
          delete out.match;
          if (out.backoff.type === 'exponential') delete out.backoff.value;
          else { delete out.backoff.start; delete out.backoff.max; }
        }
        if (out.type === 'time_window') {
          delete out.count; delete out.period; delete out.anchor;
          // An empty `days` means "every day"; leave it out of the file.
          if (!out.days?.length) delete out.days;
        } else {
          delete out.forbidden; delete out.days;
        }
        return out;
      });
      await this.guard(async () => {
        await api(`/api/upstreams/${encodeURIComponent(u.model)}`, {
          method: 'PUT',
          body: JSON.stringify({ enabled: u.enabled, limits }),
        });
        await this.loadStatus();
      }, `已保存 ${u.model}`);
    },

    async deleteUpstream(id) {
      if (!confirm(`删除上游 ${id}？`)) return;
      await this.guard(async () => {
        await api(`/api/upstreams/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await this.loadAll();
      }, `已删除 ${id}`);
    },

    async toggleUpstream(id, enabled) {
      await this.guard(async () => {
        await api(`/api/upstreams/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: JSON.stringify({ enabled }),
        });
        await this.loadAll();
      }, `${id} 已${enabled ? '启用' : '停用'}`);
    },

    addLimit(u, type) {
      const templates = {
        frequency: { type: 'frequency', count: 30, period: '1min' },
        tokens: { type: 'tokens', count: 1000000, period: '1d' },
        time_window: {
          type: 'time_window',
          forbidden: [{ start: '08:00', end: '10:00' }],
          days: [],
        },
        error_backoff: {
          type: 'error_backoff', window: 5, threshold: 1,
          backoff: { type: 'exponential', start: '60s', max: '24h' },
        },
      };
      u.limits.push(JSON.parse(JSON.stringify(templates[type])));
    },

    // --- groups ---

    newGroup() {
      const entry_model = prompt('新入口模型名：');
      if (!entry_model) return;
      this.guard(async () => {
        await api('/api/groups', {
          method: 'POST',
          body: JSON.stringify({ entry_model, routes: [] }),
        });
        await this.loadConfig();
      }, `已新增入口模型 ${entry_model}`);
    },

    addRoute(g) {
      if (!this.upstreams.length) return this.notify('请先添加上游', 'error');
      g.routes.push({ upstream: this.upstreams[0].model, priority: 100, enabled: true });
    },

    move(arr, i, delta) {
      const j = i + delta;
      if (j < 0 || j >= arr.length) return;
      const swap = () => { [arr[i], arr[j]] = [arr[j], arr[i]]; };
      document.startViewTransition ? document.startViewTransition(swap) : swap();
    },

    async saveGroup(g) {
      await this.guard(async () => {
        await api(`/api/groups/${encodeURIComponent(g.entry_model)}`, {
          method: 'PUT',
          body: JSON.stringify({ routes: g.routes }),
        });
      }, `已保存 ${g.entry_model}`);
    },

    async deleteGroup(entry_model) {
      if (!confirm(`删除入口模型 ${entry_model}？`)) return;
      await this.guard(async () => {
        await api(`/api/groups/${encodeURIComponent(entry_model)}`, { method: 'DELETE' });
        await this.loadConfig();
      }, `已删除入口模型 ${entry_model}`);
    },

    // --- logs ---

    async clearBackoff(id) {
      await this.guard(async () => {
        await api('/mcp', {
          method: 'POST',
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'clear_backoff', arguments: { upstream_id: id } },
          }),
        });
        await this.loadStatus();
      }, `${id} 已恢复`);
    },

    async pruneLogs() {
      const choice = prompt('清理选项：\n  1h / 24h / 7d = 保留该时间内\n  keep100 / keep500 = 保留最近N条', '24h');
      if (!choice) return;
      let q = '';
      if (/^(\d+)h$/.test(choice)) q = `?hours=${choice.slice(0, -1)}`;
      else if (/^(\d+)d$/.test(choice)) q = `?days=${choice.slice(0, -1)}`;
      else if (/^keep(\d+)$/.test(choice)) q = `?keep=${choice.slice(4)}`;
      else return this.notify('无法识别的选项', 'error');

      await this.guard(async () => {
        const r = await api('/api/logs' + q, { method: 'DELETE' });
        await this.loadLogs();
        this.notify(`已删除 ${r.deleted} 条记录`);
      });
    },

    limitLabel(type) {
      return { frequency: '频率限制', tokens: 'Token 配额', time_window: '禁止时段', error_backoff: '错误熔断' }[type] || type;
    },

    weekdayName(d) {
      return ['一', '二', '三', '四', '五', '六', '日'][d - 1];
    },

    toggleDay(limit, day, on) {
      const days = new Set(limit.days || []);
      on ? days.add(day) : days.delete(day);
      limit.days = [...days].sort((a, b) => a - b);
    },

    fmt(n) {
      if (n == null) return '-';
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
      return String(n);
    },

    upstreamName(model) { return model; },

    isUnavailable(u) {
      return !u || !u.enabled || (u.limits || []).some(l =>
        l.blocked || ((l.type === 'frequency' || l.type === 'tokens') && l.used >= l.limit));
    },

    activeUpstreamsCount() {
      const list = this.status?.upstreams || [];
      return list.filter(u => !this.isUnavailable(u)).length;
    },

    durationAmount(value) {
      return String(value || '1min').match(/^[0-9]+/)?.[0] || 1;
    },

    durationUnit(value) {
      return String(value || '1min').match(/[a-z]+$/i)?.[0] || 'min';
    },

    setDuration(target, key, amount, unit) {
      target[key] = `${Math.max(1, Number(amount) || 1)}${unit}`;
    },

    rulePasses(l) {
      if (l.type === 'frequency' || l.type === 'tokens') return Number(l.used) < Number(l.limit);
      return !l.blocked;
    },

    statusRuleText(l) {
      if (l.type === 'frequency') return `每 ${l.period} 最多允许 ${this.fmt(l.limit)} 次请求，周期按网关本地 00:00 对齐`;
      if (l.type === 'tokens') return `每 ${l.period} 最多消耗 ${this.fmt(l.limit)} Token${l.weighted ? '（按配置倍率加权）' : ''}，周期按网关本地 00:00 对齐`;
      if (l.type === 'time_window') return `在 ${(l.forbidden || []).join('、') || '未配置'} 禁止使用${l.days?.length ? `，星期 ${l.days.join('、')} 生效` : '，每天生效'}`;
      return `最近 ${l.window} 次调用中累计 ${l.threshold} 次失败就暂停该上游；期间转给同组其他上游，成功一次即清零重来`;
    },

    configRuleText(l) {
      if (l.type === 'frequency') return `效果：每 ${l.period} 最多允许 ${this.fmt(l.count)} 次请求；超限后暂停使用，周期按网关本地 00:00 对齐。`;
      if (l.type === 'tokens') return `效果：每 ${l.period} 最多消耗 ${this.fmt(l.count)} Token${l.weight ? '（按倍率加权）' : ''}；用完后暂停使用，周期按网关本地 00:00 对齐。`;
      if (l.type === 'time_window') return `效果：在 ${(l.forbidden || []).map(w => `${w.start}–${w.end}`).join('、') || '未设置时段'} 内暂停使用该上游；请求将自动转给同组备用上游。`;
      const delay = l.backoff?.type === 'fixed' ? `固定暂停 ${l.backoff.value}` : `首次暂停 ${l.backoff?.start}，连续触发时指数递增至上限 ${l.backoff?.max}`;
      return `效果：最近 ${l.window} 次调用中累计 ${l.threshold} 次失败即熔断暂停；${delay}；恢复后成功一次即清零计数。`;
    },
  };
}

/** `8:00` -> `08:00`, which is what `<input type="time">` requires. */
function padTime(v) {
  if (typeof v !== 'string') return v;
  const [h = '0', m = '0', ...rest] = v.split(':');
  const p = (n) => String(n).padStart(2, '0');
  return rest.length ? `${p(h)}:${p(m)}:${p(rest[0])}` : `${p(h)}:${p(m)}`;
}

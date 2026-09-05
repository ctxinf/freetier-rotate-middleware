// Native Web Components for rendering times in the gateway's timezone.
//
// Every timestamp the API returns is UTC, but a time_window limit is written
// against the gateway's *local* clock — so showing a browser-local or raw UTC
// time would quietly contradict the rules the operator wrote. These elements
// take the zone from `/api/runtime` and render every timestamp through it, so
// the UI reads the same clock the limiter does even when the browser sits in a
// different timezone.

/** The gateway's zone, published once at boot and shared by every instance. */
const gatewayClock = {
  timezone: '',
  offsetSecs: 0,
  source: '',
  /** Instances waiting to re-render once the zone is known. */
  listeners: new Set(),

  set(info = {}) {
    this.timezone = info.timezone || '';
    this.offsetSecs = info.offset_secs ?? 0;
    this.source = info.source || '';
    for (const fn of this.listeners) fn();
  },

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },

  /**
   * Format a UTC instant in the gateway's zone.
   *
   * Intl does the zone maths when we have an IANA name; the fixed-offset path
   * is the fallback for a host whose zone could not be named (the server then
   * reports UTC plus an offset).
   */
  format(date, { withDate = true, withSeconds = true } = {}) {
    if (this.timezone) {
      try {
        return new Intl.DateTimeFormat('zh-CN', {
          timeZone: this.timezone,
          hour12: false,
          ...(withDate ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {}),
          hour: '2-digit',
          minute: '2-digit',
          ...(withSeconds ? { second: '2-digit' } : {}),
        }).format(date);
      } catch {
        // An unknown zone name falls through to the offset arithmetic below.
      }
    }
    const shifted = new Date(date.getTime() + this.offsetSecs * 1000);
    const p = (n) => String(n).padStart(2, '0');
    const time = `${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}` +
      (withSeconds ? `:${p(shifted.getUTCSeconds())}` : '');
    if (!withDate) return time;
    return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())} ${time}`;
  },

  /** `+08:00`, the suffix that makes a rendered time unambiguous. */
  offsetLabel() {
    const sign = this.offsetSecs < 0 ? '-' : '+';
    const abs = Math.abs(this.offsetSecs);
    const p = (n) => String(n).padStart(2, '0');
    return `${sign}${p(Math.floor(abs / 3600))}:${p(Math.floor((abs % 3600) / 60))}`;
  },
};

/**
 * `<local-time value="2026-09-02T08:21:45Z">` → the same instant in the
 * gateway's zone, with the full UTC value on hover.
 *
 * `compact` drops the year for table cells; `date` hides the date entirely.
 */
class LocalTime extends HTMLElement {
  static observedAttributes = ['value', 'compact', 'no-date'];

  connectedCallback() {
    // Re-render when the zone arrives, which is usually after first paint.
    this.unsubscribe = gatewayClock.subscribe(() => this.render());
    this.render();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  render() {
    const raw = this.getAttribute('value');
    if (!raw) {
      this.textContent = '-';
      this.removeAttribute('title');
      return;
    }
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      // Not a timestamp we understand — show it as-is rather than "Invalid Date".
      this.textContent = raw;
      return;
    }

    const full = gatewayClock.format(date, { withDate: !this.hasAttribute('no-date') });
    // Table cells are tight: drop the redundant year.
    this.textContent = this.hasAttribute('compact') ? full.replace(/^\d{4}[-/]/, '') : full;
    this.title = `${raw} (UTC)\n${full} ${gatewayClock.offsetLabel()} ${gatewayClock.timezone}`;
  }
}

/**
 * `<tz-badge>` — which clock the page is showing, and where it came from.
 * Attributes are optional: without them it renders the shared gateway clock.
 */
class TzBadge extends HTMLElement {
  static observedAttributes = ['tz', 'offset', 'source'];

  connectedCallback() {
    this.unsubscribe = gatewayClock.subscribe(() => this.render());
    this.render();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  render() {
    const tz = this.getAttribute('tz') || gatewayClock.timezone;
    if (!tz) {
      this.textContent = '';
      return;
    }
    const source = this.getAttribute('source') || gatewayClock.source;
    this.className = 'tz-badge';
    this.innerHTML = `<svg class="icon icon-sm" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg><span>${tz} ${gatewayClock.offsetLabel()}</span>`;
    const origin = { config: '配置文件指定', system: '读取自系统时区', fallback: '无法读取系统时区，回落到 UTC' }[source] || source;
    this.title = `网关时区：${tz}（${origin}）\n页面所有时间、以及“时段限制”都以此时区为准。`;
  }
}

customElements.define('local-time', LocalTime);
customElements.define('tz-badge', TzBadge);

// Consumed by app.js once /api/runtime answers.
window.gatewayClock = gatewayClock;

export type PageName = 'live' | 'network' | 'analytics' | 'reports';

const PAGE_NAMES: PageName[] = ['live', 'network', 'analytics', 'reports'];

const sections: Record<PageName, HTMLElement> = {
  live: document.querySelector('section.page[data-page="live"]')!,
  network: document.querySelector('section.page[data-page="network"]')!,
  analytics: document.querySelector('section.page[data-page="analytics"]')!,
  reports: document.querySelector('section.page[data-page="reports"]')!,
};

const navLinks = document.querySelectorAll<HTMLAnchorElement>('nav.header-nav a[data-page]');

const activateHandlers: Partial<Record<PageName, () => void>> = {};

/** Registers a callback fired every time the user navigates to `page`. */
export function onActivate(page: PageName, cb: () => void): void {
  activateHandlers[page] = cb;
}

function currentPage(): PageName {
  const hash = location.hash.replace(/^#\//, '') as PageName;
  return PAGE_NAMES.includes(hash) ? hash : 'live';
}

function show(page: PageName): void {
  PAGE_NAMES.forEach((p) => {
    sections[p].hidden = p !== page;
  });
  navLinks.forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  activateHandlers[page]?.();
}

export function initRouter(): void {
  window.addEventListener('hashchange', () => show(currentPage()));
  show(currentPage());
}

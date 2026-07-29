import type { ReactElement, SVGProps } from 'react';

type IconName = 'home' | 'panel-left' | 'panel-right' | 'file' | 'search' | 'star' | 'folder' | 'folder-plus' |
  'file-plus' | 'sort' | 'locate' | 'collapse' | 'sun' | 'moon' | 'tag' | 'outline' | 'properties' |
  'backlinks' | 'close' | 'chevron' | 'more' | 'edit' | 'settings' | 'media' | 'history' | 'save' |
  'preview' | 'code' | 'help' | 'menu' | 'upload' | 'image' | 'logout' | 'trash' | 'publish' | 'clock' | 'lock';

const paths: Record<IconName, ReactElement> = {
  home: <><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/></>,
  'panel-left': <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></>,
  'panel-right': <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></>,
  file: <><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>,
  folder: <path d="M3 6h7l2 2h9v11H3z"/>,
  'folder-plus': <><path d="M3 6h7l2 2h9v11H3z"/><path d="M12 11v5m-2.5-2.5h5"/></>,
  'file-plus': <><path d="M5 2h9l5 5v15H5z"/><path d="M14 2v5h5M12 11v6m-3-3h6"/></>,
  sort: <><path d="M8 6h12M8 12h8M8 18h4"/><path d="m3 5 2-2 2 2M5 3v16m-2-2 2 2 2-2"/></>,
  locate: <><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/></>,
  collapse: <><path d="m8 4 4 4 4-4M8 20l4-4 4 4"/><path d="M4 12h16"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M19 5l-1.5 1.5m-11 11L5 19"/></>,
  moon: <path d="M20 15.2A8 8 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z"/>,
  tag: <path d="M3 12V4h8l10 10-7 7z"/>, outline: <><path d="M9 6h12M9 12h9M9 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></>,
  properties: <><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="11" cy="18" r="2"/></>,
  backlinks: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1"/></>,
  close: <path d="m6 6 12 12M18 6 6 18"/>, chevron: <path d="m9 6 6 6-6 6"/>, more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  edit: <><path d="m4 16-1 5 5-1L20 8l-4-4z"/><path d="m14 6 4 4"/></>, settings: <><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.8-1.8.9-1.9-2.2-2.2-1.9.9-1.8-.8-.7-2h-3l-.7 2-1.8.8-1.9-.9L.9 6.1 1.8 8 1 9.8l-2 .7v3l2 .7.8 1.8-.9 1.9 2.2 2.2 1.9-.9 1.8.8.7 2h3l.7-2 1.8-.8 1.9.9 2.2-2.2-.9-1.9.8-1.8z" transform="translate(2) scale(.83)"/></>,
  media: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m4 18 5-5 4 3 3-4 5 6"/></>, history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></>,
  save: <><path d="M4 3h14l2 2v16H4z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/></>, preview: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>, code: <path d="m8 8-4 4 4 4m8-8 4 4-4 4m-3-10-2 12"/>,
  help: <><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.8 2.8 0 1 1 3.8 2.6c-.9.4-1.3 1-1.3 1.9M12 17h.01"/></>, menu: <path d="M4 6h16M4 12h16M4 18h16"/>, upload: <><path d="M12 16V3m-4 4 4-4 4 4"/><path d="M4 14v7h16v-7"/></>, image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m4 18 5-5 4 3 3-4 5 6"/></>, logout: <><path d="M10 4H4v16h6M14 8l4 4-4 4m4-4H9"/></>, trash: <><path d="M4 7h16M9 3h6l1 4M7 7l1 14h8l1-14M10 11v6m4-6v6"/></>, publish: <><path d="M12 19V5m-5 5 5-5 5 5"/><path d="M4 15v6h16v-6"/></>, clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>, lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>,
};

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}

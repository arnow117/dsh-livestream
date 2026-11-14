/** Browser-side measurements for the original Drawer; safe to serialize into either runner. */
export function readPublicChatGeometry() {
  const drawer = document.querySelector<HTMLElement>('.dl-drawer');
  const panel = document.querySelector<HTMLElement>('.dl-public-chat');
  if (!drawer || !panel) throw new Error('public chat drawer unavailable');
  const drawerBox = drawer.getBoundingClientRect();
  const rect = (element: Element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, width: box.width };
  };
  const elements = [...panel.querySelectorAll<HTMLElement>('button,label,input,textarea,select,p,h4,dt,dd')]
    .filter((element) => element.getClientRects().length > 0)
    .map((element) => ({ tag: element.tagName, text: (element.textContent ?? '').slice(0, 80),
      box: rect(element), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
    drawer: { clientWidth: drawer.clientWidth, scrollWidth: drawer.scrollWidth, scrollLeft: drawer.scrollLeft,
      box: { left: drawerBox.left, right: drawerBox.right, width: drawerBox.width } },
    panel: { clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth, box: rect(panel) },
    clipped: elements.filter((element) => element.box.left < drawerBox.left - 1 || element.box.right > drawerBox.right + 1),
    textOverflow: elements.filter((element) => ['BUTTON', 'LABEL', 'P', 'H4', 'DT', 'DD'].includes(element.tag)
      && element.scrollWidth > element.clientWidth + 1),
  };
}

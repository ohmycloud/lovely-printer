// Native <select> popup placement is controlled by the OS. These listboxes are
// anchored below their trigger, including inside a scrolling modal dialog.
export function enhanceSelects(selects) {
  const controls = [];
  let opened = null;
  for (const select of selects) {
    const wrapper = document.createElement('div'); wrapper.className = 'select-control';
    select.before(wrapper); wrapper.append(select); select.hidden = true;
    select.setAttribute('aria-hidden', 'true'); select.tabIndex = -1;
    const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'select-trigger';
    trigger.id = `${select.id}-trigger`;
    trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-autocomplete', 'none');
    const label = document.querySelector(`label[for="${select.id}"]`);
    if (label) {
      label.id ||= `${select.id}-label`; label.htmlFor = trigger.id;
      trigger.setAttribute('aria-labelledby', label.id);
    }
    const caption = document.createElement('span');
    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.setAttribute('viewBox', '0 0 24 24'); chevron.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'm7 10 5 5 5-5'); chevron.append(path);
    trigger.append(caption, chevron); wrapper.append(trigger);
    const menu = document.createElement('div'); menu.className = 'select-menu'; menu.id = `${select.id}-options`;
    menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-labelledby', label?.id || trigger.id);
    menu.setAttribute('popover', 'manual'); menu.hidden = true; wrapper.append(menu);
    trigger.setAttribute('aria-controls', menu.id);
    let active = 0, isOpen = false;
    const options = [...select.options].map((option, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1;
      button.id = `${select.id}-option-${index}`; button.setAttribute('role', 'option');
      button.dataset.value = option.value; button.textContent = option.textContent;
      button.disabled = option.disabled;
      button.addEventListener('pointerdown', event => event.preventDefault());
      button.addEventListener('pointermove', () => { active = index; highlight(); });
      button.onclick = () => choose(index);
      menu.append(button); return button;
    });
    function highlight() {
      options.forEach((option, index) => option.classList.toggle('active', index === active));
      if (isOpen) trigger.setAttribute('aria-activedescendant', options[active].id);
    }
    function sync() {
      caption.textContent = select.selectedOptions[0]?.textContent || '';
      options.forEach((option, index) => option.setAttribute('aria-selected', String(index === select.selectedIndex)));
      trigger.disabled = select.disabled;
    }
    function position(allowScroll = false) {
      let rect = trigger.getBoundingClientRect();
      const viewport = window.visualViewport?.height || innerHeight;
      const desired = Math.min(options.length * 39 + 10, viewport - 40);
      const dialog = select.closest('dialog');
      const overflow = rect.bottom + 6 + desired - (viewport - 12);
      // Make room below instead of flipping the listbox above its trigger.
      if (allowScroll && dialog && overflow > 0) {
        dialog.scrollTop += overflow;
        rect = trigger.getBoundingClientRect();
      }
      menu.style.left = `${rect.left}px`; menu.style.top = `${rect.bottom + 6}px`;
      menu.style.width = `${rect.width}px`;
      menu.style.maxHeight = `${Math.max(36, viewport - rect.bottom - 18)}px`;
    }
    function close(focus = false) {
      if (!isOpen) return;
      isOpen = false;
      if (typeof menu.hidePopover === 'function' && menu.matches(':popover-open')) menu.hidePopover();
      menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-activedescendant');
      if (opened === control) opened = null;
      if (focus) trigger.focus({ preventScroll: true });
    }
    function open() {
      if (trigger.disabled) return;
      opened?.close(); isOpen = true; opened = control; active = Math.max(0, select.selectedIndex);
      menu.hidden = false; position(true);
      if (typeof menu.showPopover === 'function') menu.showPopover();
      else menu.classList.add('select-menu-fallback');
      trigger.setAttribute('aria-expanded', 'true'); highlight();
    }
    function choose(index) {
      if (options[index].disabled) return;
      select.selectedIndex = index;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      sync(); close(true);
    }
    const control = { sync, close, wrapper };
    trigger.onclick = () => isOpen ? close() : open();
    trigger.addEventListener('keydown', event => {
      if (event.key === 'Escape' && isOpen) {
        event.preventDefault(); event.stopPropagation(); close(true);
      } else if (event.key === 'Tab') close();
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        if (!isOpen) open();
        else if (event.key === 'ArrowDown') active = (active + 1) % options.length;
        else if (event.key === 'ArrowUp') active = (active + options.length - 1) % options.length;
        if (event.key === 'Home') active = 0;
        if (event.key === 'End') active = options.length - 1;
        highlight(); options[active].scrollIntoView({ block: 'nearest' });
      } else if (['Enter', ' '].includes(event.key)) {
        event.preventDefault(); isOpen ? choose(active) : open();
      }
    });
    select.addEventListener('change', sync);
    const dialog = select.closest('dialog');
    dialog?.addEventListener('close', () => close());
    dialog?.addEventListener('scroll', () => { if (isOpen) position(); });
    controls.push(control); sync();
  }
  document.addEventListener('pointerdown', event => {
    if (opened && !opened.wrapper.contains(event.target)) opened.close();
  });
  addEventListener('resize', () => opened?.close());
  return { sync: () => controls.forEach(control => control.sync()), close: () => opened?.close() };
}

// Объявления контракта плагина: только типы и дополнение карты Contracts, кода здесь нет.

declare module '@cyborg-harness/contracts' {
  interface Contracts {
    'session-notifications.switch': { 1: NotificationsSwitch };
  }
}

/**
 * Выключатель уведомлений о ждущих сессиях. Контракт нужен меню окна: ядро берёт из `isOn` галочку пункта «Уведомления о ждущих сессиях»
 * (`contributes.menus[].checked`); меняет выключатель команда `session-notifications.toggle`.
 */
export interface NotificationsSwitch {
  /** Уведомления включены. */
  isOn(): Promise<boolean>;
}

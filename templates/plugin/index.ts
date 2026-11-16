import type { PluginModule } from '@cyborg-harness/contracts';
import type { Greeting } from './contracts.ts';

const DEFAULT_GREETING = 'привет';

const plugin: PluginModule = {
  config: { defaults: { greeting: DEFAULT_GREETING } },
  activate(ctx) {
    const greeting = (): string => {
      const value = ctx.config?.get().greeting;
      return typeof value === 'string' ? value : DEFAULT_GREETING;
    };
    const provider: Greeting = { greet: async (name) => `${greeting()}, ${name}` };
    ctx.contracts.provide('__ID__.greeting', '1.0', provider);
    ctx.commands.register('__ID__.hello', () => {
      ctx.log('команда вызвана');
      return greeting();
    });
    return undefined;
  },
};

export default plugin;

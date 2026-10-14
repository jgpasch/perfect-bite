// Jest setup: tests always run in English (spec 4.15), whatever the machine or the env sets.
import { initI18n } from '@/i18n';

delete process.env.EXPO_PUBLIC_FORCE_LANGUAGE;
initI18n('en');

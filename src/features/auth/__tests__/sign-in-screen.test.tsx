// Sign-in (spec 4.8, board 09): Google when configured, and in dev builds the email + 6-digit code
// stub. Buttons stay disabled until there is something to send, show progress, and errors appear.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TextInput } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { AccountState } from '@/features/auth/account';

import SignInScreen from '@/app/sign-in';

jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }) }));

const mockGoogle = { configured: false };
jest.mock('@/lib/google-sign-in', () => ({
  get isGoogleConfigured() {
    return mockGoogle.configured;
  },
}));

const mockAccount: { state: AccountState } = { state: { status: 'signedOut' } };
const mockAuth = {
  sendEmailCode: jest.fn((_email: string) => Promise.resolve()),
  verifyEmailCode: jest.fn((_email: string, _code: string) => Promise.resolve()),
  devPasswordSignIn: jest.fn((_email: string) => Promise.resolve()),
  signInWithGoogle: jest.fn(() => Promise.resolve()),
};
jest.mock('@/features/auth/account', () => ({
  useAccountState: () => mockAccount.state,
  isDevPasswordEmail: (email: string) => email.endsWith('@dev.test'),
  sendEmailCode: (email: string) => mockAuth.sendEmailCode(email),
  verifyEmailCode: (email: string, code: string) => mockAuth.verifyEmailCode(email, code),
  devPasswordSignIn: (email: string) => mockAuth.devPasswordSignIn(email),
  signInWithGoogle: () => mockAuth.signInWithGoogle(),
}));

let tree: ReactTestRenderer | null = null;

beforeEach(() => {
  mockGoogle.configured = false;
  mockAccount.state = { status: 'signedOut' };
  Object.values(mockAuth).forEach((fn) => fn.mockClear());
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

function render(): ReactTestRenderer {
  act(() => {
    tree = create(<SignInScreen />);
  });
  return tree!;
}

const buttons = (root: ReactTestRenderer) =>
  root.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'button');
const button = (root: ReactTestRenderer, label: string) => {
  const found = buttons(root).filter((b) => b.props.accessibilityLabel === label);
  if (found.length !== 1) throw new Error(`${found.length} buttons labelled ${label}`);
  return found[0];
};
const disabled = (b: ReactTestInstance) => !!b.props.accessibilityState?.disabled;
const click = (n: ReactTestInstance) => act(() => n.props.onClick({ nativeEvent: {} }));
const field = (root: ReactTestRenderer, label: string) =>
  root.root.findAllByType(TextInput).find((i) => i.props.accessibilityLabel === label)!;
const type = (input: ReactTestInstance, text: string) => act(() => input.props.onChangeText(text));

function textOf(root: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object' && 'children' in node) walk((node as { children: unknown }).children);
  };
  walk(root.toJSON());
  return out.join(' ');
}

/** A promise the test settles, to see the screen while a request is in flight. */
function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('the sign-in screen', () => {
  it('names the app in a header', () => {
    const root = render();
    const header = root.root.find((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'header');
    expect(header.props.children).toBe('The Perfect Bite');
  });

  it('without a backend, explains the setup and offers no way in', () => {
    mockAccount.state = { status: 'unconfigured' };
    const root = render();
    expect(textOf(root)).toContain('Backend not configured');
    expect(buttons(root)).toHaveLength(0);
    expect(root.root.findAllByType(TextInput)).toHaveLength(0);
  });

  it('hides Google until it is configured', () => {
    expect(buttons(render()).map((b) => b.props.accessibilityLabel)).not.toContain('Continue with Google');
    act(() => tree?.unmount());
    mockGoogle.configured = true;
    expect(buttons(render()).map((b) => b.props.accessibilityLabel)).toContain('Continue with Google');
  });

  it('Continue with Google signs in, showing progress meanwhile', async () => {
    mockGoogle.configured = true;
    const pending = deferred();
    mockAuth.signInWithGoogle.mockImplementationOnce(() => pending.promise);
    const root = render();
    click(button(root, 'Continue with Google'));
    expect(mockAuth.signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(disabled(button(root, 'Signing in…'))).toBe(true);
    await act(async () => pending.resolve());
    expect(disabled(button(root, 'Continue with Google'))).toBe(false);
  });

  it('shows a Google error', async () => {
    mockGoogle.configured = true;
    mockAuth.signInWithGoogle.mockImplementationOnce(() => Promise.reject(new Error('Network error')));
    const root = render();
    click(button(root, 'Continue with Google'));
    await act(async () => {});
    const error = root.root.find((n) => typeof n.type === 'string' && n.props.accessibilityLiveRegion === 'polite');
    expect(error.props.children).toBe('Network error');
  });

  describe('the email code (dev builds)', () => {
    it('Send code waits for an address with an @', () => {
      const root = render();
      expect(disabled(button(root, 'Send code'))).toBe(true);
      click(button(root, 'Send code'));
      expect(mockAuth.sendEmailCode).not.toHaveBeenCalled();
      type(field(root, 'Email'), 'jo@example.com');
      expect(disabled(button(root, 'Send code'))).toBe(false);
    });

    it('sends the code to the trimmed address and asks for it', async () => {
      const root = render();
      type(field(root, 'Email'), '  jo@example.com ');
      click(button(root, 'Send code'));
      await act(async () => {});
      expect(mockAuth.sendEmailCode).toHaveBeenCalledWith('jo@example.com');
      expect(textOf(root)).toContain('Enter the 6-digit code sent to jo@example.com.');
      expect(field(root, 'Sign-in code')).toBeDefined();
      expect(field(root, 'Email')).toBeUndefined();
    });

    it('return on the email field sends the code too', async () => {
      const root = render();
      type(field(root, 'Email'), 'jo@example.com');
      await act(async () => field(root, 'Email').props.onSubmitEditing());
      expect(mockAuth.sendEmailCode).toHaveBeenCalledWith('jo@example.com');
    });

    it('shows Sending… while the code is on its way', async () => {
      const pending = deferred();
      mockAuth.sendEmailCode.mockImplementationOnce(() => pending.promise);
      const root = render();
      type(field(root, 'Email'), 'jo@example.com');
      click(button(root, 'Send code'));
      expect(disabled(button(root, 'Sending…'))).toBe(true);
      await act(async () => pending.resolve());
      expect(field(root, 'Sign-in code')).toBeDefined();
    });

    it('stays on the email step with the error when sending fails', async () => {
      mockAuth.sendEmailCode.mockImplementationOnce(() => Promise.reject(new Error('Rate limited')));
      const root = render();
      type(field(root, 'Email'), 'jo@example.com');
      click(button(root, 'Send code'));
      await act(async () => {});
      expect(textOf(root)).toContain('Rate limited');
      expect(field(root, 'Email')).toBeDefined();
      expect(disabled(button(root, 'Send code'))).toBe(false);
    });

    it('signs in a dev password address directly, with no code step', async () => {
      const root = render();
      type(field(root, 'Email'), 'a@dev.test');
      click(button(root, 'Send code'));
      await act(async () => {});
      expect(mockAuth.devPasswordSignIn).toHaveBeenCalledWith('a@dev.test');
      expect(mockAuth.sendEmailCode).not.toHaveBeenCalled();
      expect(field(root, 'Email')).toBeDefined();
    });

    async function toCodeStep() {
      const root = render();
      type(field(root, 'Email'), 'jo@example.com');
      click(button(root, 'Send code'));
      await act(async () => {});
      return root;
    }

    it('Sign in waits for six digits, then verifies the trimmed code', async () => {
      const root = await toCodeStep();
      const code = field(root, 'Sign-in code');
      expect(code.props.maxLength).toBe(6);
      type(code, '12345');
      expect(disabled(button(root, 'Sign in'))).toBe(true);
      type(field(root, 'Sign-in code'), '123456');
      click(button(root, 'Sign in'));
      await act(async () => {});
      expect(mockAuth.verifyEmailCode).toHaveBeenCalledWith('jo@example.com', '123456');
    });

    it('shows a wrong code’s error', async () => {
      mockAuth.verifyEmailCode.mockImplementationOnce(() => Promise.reject('Token has expired or is invalid'));
      const root = await toCodeStep();
      type(field(root, 'Sign-in code'), '000000');
      await act(async () => field(root, 'Sign-in code').props.onSubmitEditing());
      expect(textOf(root)).toContain('Token has expired or is invalid');
    });

    it('Use a different email goes back to the email step, keeping the address', async () => {
      const root = await toCodeStep();
      click(button(root, 'Use a different email'));
      expect(field(root, 'Email').props.value).toBe('jo@example.com');
      expect(textOf(root)).toContain('sorted by aisle');
    });

    it('Google is offered only on the email step', async () => {
      mockGoogle.configured = true;
      const root = await toCodeStep();
      expect(buttons(root).map((b) => b.props.accessibilityLabel)).not.toContain('Continue with Google');
    });
  });
});

// The hidden WebView behind `capturePage` (spec 4.10). Mounted once at the root; it renders nothing
// visible and only loads a page while a capture is running.
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { CAPTURE_SCRIPT, createCaptureSession, setPageCapturer, type CaptureResult, type CaptureSession } from './page-capture';

type Capture = { key: number; url: string; session: CaptureSession };

export function PageCaptureHost() {
  const [capture, setCapture] = useState<Capture | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const nextKey = useRef(0);

  useEffect(() => {
    const run = (url: string) =>
      new Promise<CaptureResult>((resolve) => {
        const key = ++nextKey.current;
        const session = createCaptureSession((result) => {
          setCapture((current) => (current?.key === key ? null : current));
          resolve(result);
        });
        setCapture({ key, url, session });
      });
    // One page at a time: each capture waits for the one before it.
    setPageCapturer((url) => {
      const result = queue.current.then(() => run(url));
      queue.current = result;
      return result;
    });
    return () => setPageCapturer(null);
  }, []);

  if (!capture) return null;
  return (
    <View
      style={styles.hidden}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <WebView
        key={capture.key}
        source={{ uri: capture.url }}
        injectedJavaScript={CAPTURE_SCRIPT}
        onMessage={(e) => capture.session.receive(e.nativeEvent.data)}
        onError={() => capture.session.fail()}
        onContentProcessDidTerminate={() => capture.session.fail()}
        // Cookies are kept, so a site's bot check passed once lets the next import straight through.
        mediaPlaybackRequiresUserAction
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Off screen and transparent, but laid out at a phone's size so the page renders as it would there.
  hidden: { position: 'absolute', left: -10_000, top: 0, width: 390, height: 844, opacity: 0 },
});

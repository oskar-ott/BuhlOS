"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Listening for the camera table, through the browser's own speech recognition.
 * Stays on until it's turned off: a recogniser stops by itself after a silence, so it's
 * started again, but if it keeps dying straight away it stops and says so.
 * The microphone is only ever opened by a person pressing the button.
 */

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type RecognitionConstructor = new () => Recognition;

function recogniser(): RecognitionConstructor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const noSubscribe = () => () => undefined;

const FATAL: Readonly<Record<string, string>> = {
  "not-allowed": "The browser has blocked the microphone. Allow it for this site, then press Talk again.",
  "service-not-allowed": "The browser has blocked speech recognition. Allow it for this site, then press Talk again.",
  "audio-capture": "No microphone found. Plug one in, then press Talk again.",
  network: "Talk needs the internet: the browser sends what it hears away to be turned into words.",
  "language-not-supported": "This browser can't listen in Australian English.",
};
const QUICK_END_MS = 1000;
const QUICK_ENDS_ALLOWED = 3;

export function useSpeech(onFinal: (text: string) => void) {
  const supported = useSyncExternalStore(noSubscribe, () => Boolean(recogniser()), () => false);
  const [on, setOn] = useState(false);
  const [interim, setInterim] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const wanted = useRef(false);
  const current = useRef<Recognition | null>(null);
  const startedAt = useRef(0);
  const quickEnds = useRef(0);
  const onFinalRef = useRef(onFinal);
  useEffect(() => {
    onFinalRef.current = onFinal;
  });

  const halt = useCallback((why: string | null) => {
    wanted.current = false;
    current.current?.abort();
    current.current = null;
    setOn(false);
    setInterim("");
    setProblem(why);
  }, []);

  const begin = useCallback(() => {
    const Ctor = recogniser();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = "en-AU";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      const partial: string[] = [];
      const finished: string[] = [];
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]!;
        const text = result[0].transcript.trim();
        if (text) (result.isFinal ? finished : partial).push(text);
      }
      setInterim(partial.join(" "));
      // As one phrase: a screen update can't be counted on between two.
      if (finished.length) onFinalRef.current(finished.join(" "));
    };
    rec.onerror = (e) => {
      // No speech for a while, or our own stop: not worth saying.
      const why = FATAL[e.error];
      if (why) halt(why);
    };
    rec.onend = () => {
      if (current.current !== rec) return;
      current.current = null;
      setInterim("");
      if (!wanted.current) return;
      quickEnds.current = Date.now() - startedAt.current < QUICK_END_MS ? quickEnds.current + 1 : 0;
      if (quickEnds.current >= QUICK_ENDS_ALLOWED) halt("The microphone keeps cutting out. Check it in the browser, then press Talk again.");
      else begin();
    };
    current.current = rec;
    startedAt.current = Date.now();
    try {
      rec.start();
    } catch {
      halt("The browser wouldn't start listening. Press Talk again.");
    }
  }, [halt]);

  const toggle = useCallback(() => {
    if (wanted.current) {
      halt(null);
      return;
    }
    wanted.current = true;
    quickEnds.current = 0;
    setProblem(null);
    setOn(true);
    begin();
  }, [begin, halt]);

  // Leaving the screen closes the microphone.
  useEffect(() => () => {
    wanted.current = false;
    current.current?.abort();
    current.current = null;
  }, []);

  return { supported, on, interim, problem, toggle };
}

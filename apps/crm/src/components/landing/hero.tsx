"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, MotionConfig, useReducedMotion } from "motion/react";
import { Play, RotateCcw } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Wordmark } from "./wordmark";
import { PLAY_MODE, SESSION_KEY } from "./intro/constants";
import { IntroAudioEngine } from "./intro/audio/audio-engine";
import type { IntroBridge } from "./intro/IntroExperience";
import { detectTier } from "./intro/tier";

const ResonanceScene = dynamic(() => import("./scene/resonance-scene"), {
  ssr: false,
});

const HEADLINE_WORDS = ["Campaigns", "that", "resonate."] as const;
const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

function supportsWebgl(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl2") ?? canvas.getContext("webgl")
    );
  } catch {
    return false;
  }
}

/** Decides whether the Stellar Genesis film should play this visit. */
function resolveIntroTier(): "high" | "med" | null {
  if (PLAY_MODE === "off") {
    return null;
  }
  if (PLAY_MODE === "session") {
    try {
      if (window.sessionStorage.getItem(SESSION_KEY)) {
        return null;
      }
    } catch {
      return null;
    }
  }
  const tier = detectTier();
  return tier === "low" ? null : tier;
}

export function Hero() {
  const router = useRouter();
  const reducedMotion = useReducedMotion();
  const [webgl, setWebgl] = useState<boolean | null>(null);
  const [tier, setTier] = useState<"high" | "med" | null>(null);
  const [sceneReady, setSceneReady] = useState(false);
  const [revealFallback, setRevealFallback] = useState(false);
  const [skipVisible, setSkipVisible] = useState(false);
  const [introDone, setIntroDone] = useState(false);
  const [started, setStarted] = useState(false);
  const [replayNonce, setReplayNonce] = useState(0);

  const skipFnRef = useRef<(() => void) | null>(null);
  const audioRef = useRef<IntroAudioEngine | null>(null);
  const bridgeRef = useRef<IntroBridge | null>(null);
  if (bridgeRef.current === null) {
    bridgeRef.current = {
      flashEl: null,
      onBeat: (beat: string) => {
        // The void → system boundary sits exactly at SKIP_AFTER.
        if (beat === "system") {
          setSkipVisible(true);
        }
        audioRef.current?.beat(beat as Parameters<IntroAudioEngine["beat"]>[0]);
      },
      onDone: () => {
        setIntroDone(true);
        setSkipVisible(false);
        if (PLAY_MODE === "session") {
          try {
            window.sessionStorage.setItem(SESSION_KEY, "1");
          } catch {
            // Storage may be unavailable; replaying next visit is fine.
          }
        }
      },
      registerSkip: (fn) => {
        skipFnRef.current = fn;
      },
    };
  }
  const bridge = bridgeRef.current;

  useEffect(() => {
    const ok = supportsWebgl();
    setWebgl(ok);
    setTier(ok ? resolveIntroTier() : null);
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => setRevealFallback(true), 2400);
    return () => window.clearTimeout(id);
  }, []);

  // Warm the app routes while the landing/intro is on screen so the first
  // in-app navigation ("Open dashboard") is instant — no on-demand wait.
  useEffect(() => {
    router.prefetch("/dashboard");
    router.prefetch("/customers");
    router.prefetch("/segments");
  }, [router]);

  const handleSceneReady = useCallback(() => setSceneReady(true), []);

  const posterOnly = webgl === false || reducedMotion === true;
  const mountCanvas = webgl === true && reducedMotion !== true;
  const cinematic = mountCanvas && tier !== null;
  const revealed = cinematic
    ? introDone
    : sceneReady || posterOnly || revealFallback;

  const triggerSkip = useCallback(() => {
    const skip = skipFnRef.current;
    if (skip) {
      skip();
      setSkipVisible(false);
    }
  }, []);

  // Sound is always on — there is no mute. The browser requires one user
  // gesture before audio may play, so the film does not start until the
  // listener presses "Begin"; that same gesture arms the score.
  const enableSound = useCallback(async () => {
    if (!audioRef.current) {
      audioRef.current = new IntroAudioEngine();
    }
    await audioRef.current.enable();
  }, []);

  // The single entry point: arm sound, then start the film (picture + score
  // begin together, from frame one).
  const begin = useCallback(async () => {
    await enableSound();
    setStarted(true);
  }, [enableSound]);

  // Replay the film from the top with sound (it is always on).
  const replayWithSound = useCallback(async () => {
    if (!audioRef.current) {
      audioRef.current = new IntroAudioEngine();
    }
    audioRef.current.rewind();
    await audioRef.current.enable();
    setSceneReady(false);
    setSkipVisible(false);
    setIntroDone(false);
    setReplayNonce((n) => n + 1);
  }, []);

  // Dispose the audio graph when the hero unmounts.
  useEffect(() => {
    return () => {
      audioRef.current?.dispose();
      audioRef.current = null;
    };
  }, []);

  // Suspend the score with the tab; resume when the listener returns.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        audioRef.current?.suspend();
      } else {
        audioRef.current?.resumeIfEnabled();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Scroll lock for the duration of the film.
  useEffect(() => {
    if (!cinematic || introDone) {
      return;
    }
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [cinematic, introDone]);

  // Esc / Enter fast-forward to the handoff.
  useEffect(() => {
    if (!cinematic || introDone) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === "Escape") {
        triggerSkip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cinematic, introDone, triggerSkip]);

  const setFlashEl = useCallback(
    (el: HTMLDivElement | null) => {
      bridge.flashEl = el;
    },
    [bridge]
  );

  const scrollToLoop = useCallback(() => {
    document.getElementById("loop")?.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "start",
    });
  }, [reducedMotion]);

  return (
    <MotionConfig reducedMotion="user">
      <section className="relative h-svh w-full overflow-hidden bg-[#070708]">
        {/* Static poster — always present beneath the canvas, never a blank frame. */}
        <div aria-hidden className="poster-glow absolute inset-0" />

        {mountCanvas && (!cinematic || started) ? (
          <div
            aria-hidden
            className={cn(
              "absolute inset-0",
              !cinematic && "transition-opacity duration-1000",
              !cinematic && (sceneReady ? "opacity-100" : "opacity-0")
            )}
          >
            {tier !== null ? (
              <ResonanceScene
                key={`cinematic-${replayNonce}`}
                mode="cinematic"
                bridge={bridge}
                tier={tier}
                onReady={handleSceneReady}
              />
            ) : (
              <ResonanceScene onReady={handleSceneReady} />
            )}
          </div>
        ) : null}

        {/* Legibility scrim over the lower half. */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 h-[55svh] bg-gradient-to-t from-[#070708]/95 via-[#070708]/40 to-transparent",
            cinematic && "transition-opacity duration-1000",
            cinematic && !introDone && "opacity-0"
          )}
        />

        <motion.header
          initial={false}
          animate={
            cinematic && !introDone
              ? { opacity: 0, y: -14, transition: { duration: 0.2 } }
              : {
                  opacity: 1,
                  y: 0,
                  transition: { duration: 0.7, ease: EASE_OUT, delay: 0.1 },
                }
          }
          className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-6 py-5 md:px-10"
        >
          <Link href="/" aria-label="Resonate — home">
            <Wordmark />
          </Link>
          <Link
            href="/dashboard"
            className={cn(
              buttonVariants({ variant: "ghost" }),
              "text-foreground/75 hover:text-foreground"
            )}
          >
            Open dashboard
          </Link>
        </motion.header>

        <div className="absolute inset-x-0 bottom-0 z-10 px-6 pb-24 md:px-10 lg:px-16 lg:pb-28">
          <div className="max-w-3xl">
            <motion.p
              initial={{ opacity: 0, y: 16 }}
              animate={revealed ? { opacity: 1, y: 0 } : undefined}
              transition={{ duration: 0.7, ease: EASE_OUT, delay: 0.05 }}
              className="font-mono text-[11px] uppercase tracking-[0.32em] text-copper"
            >
              AI campaign copilot for D2C brands
            </motion.p>

            <h1 className="mt-5 font-display text-[clamp(3rem,8.5vw,6.5rem)] leading-[0.98] tracking-tight text-foreground">
              {HEADLINE_WORDS.map((word, index) => (
                <motion.span
                  key={word}
                  className={cn(
                    "inline-block will-change-transform",
                    index < HEADLINE_WORDS.length - 1 && "mr-[0.24em]",
                    word === "resonate." && "italic text-copper"
                  )}
                  initial={{ opacity: 0, y: 28, filter: "blur(14px)" }}
                  animate={
                    revealed
                      ? { opacity: 1, y: 0, filter: "blur(0px)" }
                      : undefined
                  }
                  transition={{
                    duration: 0.9,
                    ease: EASE_OUT,
                    delay: 0.15 + index * 0.12,
                  }}
                >
                  {word}
                </motion.span>
              ))}
            </h1>

            <motion.p
              initial={{ opacity: 0, y: 18 }}
              animate={revealed ? { opacity: 1, y: 0 } : undefined}
              transition={{ duration: 0.8, ease: EASE_OUT, delay: 0.55 }}
              className="mt-6 max-w-xl text-base leading-relaxed text-foreground/65 md:text-lg"
            >
              Describe your audience in plain English. AI drafts the message. A
              live delivery pipeline shows you what happened — and what it
              earned.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={revealed ? { opacity: 1, y: 0 } : undefined}
              transition={{ duration: 0.8, ease: EASE_OUT, delay: 0.7 }}
              className="mt-9 flex flex-wrap items-center gap-3"
            >
              <Link
                href="/dashboard"
                className={cn(buttonVariants({ size: "lg" }), "px-5")}
              >
                Open dashboard
              </Link>
              <Button
                variant="ghost"
                size="lg"
                className="px-5 text-foreground/75 hover:text-foreground"
                onClick={scrollToLoop}
              >
                How it works
              </Button>
            </motion.div>
          </div>
        </div>

        <div
          className={cn(
            "pointer-events-none absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-2.5",
            cinematic && "transition-opacity duration-1000",
            cinematic && !introDone && "opacity-0"
          )}
        >
          <span className="text-[10px] uppercase tracking-[0.3em] text-foreground/35">
            Scroll
          </span>
          <span className="scroll-cue-line block h-10 w-px bg-gradient-to-b from-copper/80 to-transparent" />
        </div>

        {/* Entry gate: the film + score begin together on this one gesture. */}
        {cinematic && !started ? (
          <button
            type="button"
            onClick={() => void begin()}
            aria-label="Begin the intro with sound"
            className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-5 bg-[#050403]/35"
          >
            <span className="font-mono text-[11px] uppercase tracking-[0.34em] text-copper">
              AI campaign copilot for D2C brands
            </span>
            <span className="enter-pulse flex size-20 items-center justify-center rounded-full border border-copper/40 text-copper">
              <Play className="size-7 translate-x-0.5 fill-current" aria-hidden />
            </span>
            <span className="font-display text-3xl tracking-tight text-foreground/90">
              Begin
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-foreground/45">
              Click anywhere · best with sound
            </span>
          </button>
        ) : null}
        {/* Cinematic-only chrome: first-frame cover, impact flash, skip. */}
        {cinematic && started && !sceneReady ? (
          <div aria-hidden className="absolute inset-0 z-40 bg-[#050403]" />
        ) : null}
        {cinematic ? (
          <div
            ref={setFlashEl}
            aria-hidden
            className="pointer-events-none absolute inset-0 z-50 bg-white opacity-0"
          />
        ) : null}
        {cinematic && !introDone ? (
          <button
            type="button"
            onClick={triggerSkip}
            className={cn(
              "absolute bottom-6 right-6 z-50 rounded-full border border-white/15 bg-black/30 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.28em] text-foreground/70 backdrop-blur transition-opacity duration-500 hover:text-foreground",
              skipVisible ? "opacity-100" : "pointer-events-none opacity-0"
            )}
          >
            Skip ⏎
          </button>
        ) : null}
        {cinematic && introDone ? (
          <button
            type="button"
            onClick={() => void replayWithSound()}
            aria-label="Replay the intro"
            className="absolute bottom-6 right-6 z-30 flex items-center gap-2 rounded-full border border-copper/30 bg-black/40 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.28em] text-foreground/75 backdrop-blur transition-colors hover:border-copper/60 hover:text-foreground"
          >
            <RotateCcw className="size-3.5 text-copper" aria-hidden />
            Replay
          </button>
        ) : null}
      </section>
    </MotionConfig>
  );
}

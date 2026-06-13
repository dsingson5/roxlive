import { AnimatePresence, motion } from "motion/react";

/**
 * Full-screen 3-2-1 countdown shown in the final seconds of the current
 * interval (workout) or segment (HYROX). Voice is fired separately by the
 * runner / HYROX announcer; this is the big visual cue.
 */
export function CountdownOverlay({ seconds, label }: { seconds: number | null; label?: string }) {
  const show = seconds != null && seconds >= 1 && seconds <= 3;
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="fixed inset-0 z-[60] grid place-items-center pointer-events-none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="absolute inset-0" style={{ background: "radial-gradient(circle at center, rgba(7,8,10,0.72), rgba(7,8,10,0.94))" }} />
          <motion.div
            key={seconds}
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 1.6, opacity: 0 }}
            transition={{ type: "spring", stiffness: 240, damping: 18 }}
            className="relative text-center"
          >
            <div
              className="num font-bold leading-none"
              style={{
                fontSize: "min(46vw, 38vh)",
                color: seconds === 1 ? "var(--color-volt)" : "var(--color-ink)",
                textShadow: seconds === 1 ? "0 0 60px rgba(216,255,58,0.6)" : "0 0 50px rgba(255,255,255,0.25)",
              }}
            >
              {seconds}
            </div>
            {label && (
              <div className="font-[var(--font-display)] text-lg sm:text-2xl font-semibold tracking-wide mt-2" style={{ color: "var(--color-ink-dim)" }}>
                {label}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

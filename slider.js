/**
 * ImageSlider: a dependency-free, infinitely looping image slider.
 *
 * How the infinite loop works
 * ---------------------------
 * The track holds the real slides plus two clones:
 *
 *     [clone of last] [1] [2] [3] ... [N] [clone of first]
 *         pos 0       pos 1 ...      pos N     pos N+1
 *
 * - "pos" is the physical position on the track (0 .. N+1).
 * - "index" is the logical slide number (0 .. N-1) shown by the dots.
 *
 * Clicking Next on the last slide animates onto the first clone (pos N+1),
 * which looks identical to slide 1. When that animation ends, the track is
 * moved to the real slide 1 (pos 1) with transitions switched off, so the
 * jump is invisible. Previous on the first slide works the same way in reverse.
 *
 * Layout math: every slide is 100% of the viewport width, and the track is
 * the same width as the viewport, so translateX(-pos * 100%) lands exactly on
 * slide "pos". Percentages mean no pixel recalculation on resize.
 */
class ImageSlider {
  static defaults = {
    autoplay: false,    // auto advance
    interval: 4000,     // ms between auto advances
    swipeThreshold: 50, // px a drag must travel to count as a swipe
  };

  constructor(root, options = {}) {
    this.root = root;
    this.options = { ...ImageSlider.defaults, ...options };

    this.viewport = root.querySelector(".slider__viewport");
    this.track = root.querySelector(".slider__track");
    this.slides = Array.from(this.track.children);
    this.count = this.slides.length;

    this.pos = 1;              // physical track position
    this.isAnimating = false;  // blocks input mid-transition
    this.timers = { fallback: null, autoplay: null };
    this.abort = new AbortController(); // removes every listener in destroy()

    if (this.count < 2) return; // nothing to slide

    this.#addClones();
    this.#buildControls();
    this.#bindEvents();
    this.#render(false);
    this.#syncState();

    if (this.options.autoplay) this.#startAutoplay();
  }

  /* ---------- Public API ---------- */

  next() {
    this.#moveTo(this.pos + 1);
  }

  prev() {
    this.#moveTo(this.pos - 1);
  }

  /** Jump straight to a logical slide index (0-based). */
  goTo(index) {
    if (index < 0 || index >= this.count) return;
    this.#moveTo(index + 1);
  }

  /** Logical index of the slide currently in view. */
  get index() {
    return (((this.pos - 1) % this.count) + this.count) % this.count;
  }

  destroy() {
    this.abort.abort();
    this.#stopAutoplay();
    clearTimeout(this.timers.fallback);
    this.root.querySelectorAll("[data-clone], .slider__arrow, .slider__dots").forEach((el) => el.remove());
    this.track.style.transform = "";
  }

  /* ---------- Setup ---------- */

  #addClones() {
    const makeClone = (slide) => {
      const clone = slide.cloneNode(true);
      clone.setAttribute("aria-hidden", "true");
      clone.dataset.clone = "";
      return clone;
    };
    this.track.prepend(makeClone(this.slides[this.count - 1]));
    this.track.append(makeClone(this.slides[0]));
  }

  #buildControls() {
    const arrowIcon = (d) =>
      `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

    const makeArrow = (dir, label, path) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `slider__arrow slider__arrow--${dir}`;
      btn.setAttribute("aria-label", label);
      btn.innerHTML = arrowIcon(path);
      return btn;
    };

    this.prevBtn = makeArrow("prev", "Previous slide", "M15 5l-7 7 7 7");
    this.nextBtn = makeArrow("next", "Next slide", "M9 5l7 7-7 7");

    this.dotsEl = document.createElement("div");
    this.dotsEl.className = "slider__dots";

    this.dots = this.slides.map((_, i) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "slider__dot";
      dot.setAttribute("aria-label", `Go to slide ${i + 1}`);
      dot.dataset.index = i;
      this.dotsEl.append(dot);
      return dot;
    });

    this.root.append(this.prevBtn, this.nextBtn, this.dotsEl);
  }

  #bindEvents() {
    const { signal } = this.abort;

    this.prevBtn.addEventListener("click", () => this.#userAction(() => this.prev()), { signal });
    this.nextBtn.addEventListener("click", () => this.#userAction(() => this.next()), { signal });

    // One delegated listener for all dots
    this.dotsEl.addEventListener(
      "click",
      (e) => {
        const dot = e.target.closest(".slider__dot");
        if (dot) this.#userAction(() => this.goTo(Number(dot.dataset.index)));
      },
      { signal }
    );

    // Finish the loop jump once the slide animation completes
    this.track.addEventListener(
      "transitionend",
      (e) => {
        if (e.target === this.track && e.propertyName === "transform") this.#settle();
      },
      { signal }
    );

    // Keyboard: arrow keys while the slider has focus
    if (!this.root.hasAttribute("tabindex")) this.root.tabIndex = 0;
    this.root.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "ArrowRight") this.#userAction(() => this.next());
        if (e.key === "ArrowLeft") this.#userAction(() => this.prev());
      },
      { signal }
    );

    // Touch / pointer swipe
    this.viewport.style.touchAction = "pan-y";
    let startX = null;
    this.viewport.addEventListener("pointerdown", (e) => { startX = e.clientX; }, { signal });
    this.viewport.addEventListener(
      "pointerup",
      (e) => {
        if (startX === null) return;
        const dx = e.clientX - startX;
        startX = null;
        if (Math.abs(dx) < this.options.swipeThreshold) return;
        this.#userAction(() => (dx < 0 ? this.next() : this.prev()));
      },
      { signal }
    );
    this.viewport.addEventListener("pointercancel", () => { startX = null; }, { signal });

    // Pause autoplay while the user is interacting
    if (this.options.autoplay) {
      const pause = () => this.#stopAutoplay();
      const resume = () => this.#startAutoplay();
      this.root.addEventListener("mouseenter", pause, { signal });
      this.root.addEventListener("mouseleave", resume, { signal });
      this.root.addEventListener("focusin", pause, { signal });
      this.root.addEventListener("focusout", resume, { signal });
    }
  }

  /* ---------- Movement ---------- */

  #moveTo(targetPos) {
    if (this.isAnimating || targetPos === this.pos) return;

    this.isAnimating = true;
    this.pos = targetPos;
    this.#render(true);
    this.#syncState();

    // Safety net in case "transitionend" never fires (e.g. background tab)
    this.timers.fallback = setTimeout(() => this.#settle(), this.#duration() + 100);
  }

  /** Runs after each animation: silently swaps a clone for its real slide. */
  #settle() {
    if (!this.isAnimating) return;
    clearTimeout(this.timers.fallback);

    if (this.pos === 0) this.pos = this.count;           // clone of last -> real last
    else if (this.pos === this.count + 1) this.pos = 1;  // clone of first -> real first

    this.#render(false);
    this.isAnimating = false;
  }

  /** Applies the transform. animate=false disables the transition for one frame. */
  #render(animate) {
    this.track.classList.toggle("is-jumping", !animate);
    this.track.style.transform = `translate3d(${-this.pos * 100}%, 0, 0)`;
    if (!animate) {
      void this.track.offsetWidth; // force reflow so the jump applies without easing
      this.track.classList.remove("is-jumping");
    }
  }

  #syncState() {
    const active = this.index;
    this.dots.forEach((dot, i) => {
      const isActive = i === active;
      dot.classList.toggle("is-active", isActive);
      if (isActive) dot.setAttribute("aria-current", "true");
      else dot.removeAttribute("aria-current");
    });
    this.slides.forEach((slide, i) => slide.setAttribute("aria-hidden", String(i !== active)));
  }

  #duration() {
    const raw = getComputedStyle(this.track).transitionDuration.split(",")[0].trim();
    const value = parseFloat(raw) || 0;
    return raw.endsWith("ms") ? value : value * 1000;
  }

  /* ---------- Autoplay ---------- */

  #startAutoplay() {
    this.#stopAutoplay();
    this.timers.autoplay = setInterval(() => this.next(), this.options.interval);
  }

  #stopAutoplay() {
    clearInterval(this.timers.autoplay);
    this.timers.autoplay = null;
  }

  /** Manual input restarts the autoplay clock so it doesn't fire right after a click. */
  #userAction(fn) {
    fn();
    if (this.options.autoplay && this.timers.autoplay) this.#startAutoplay();
  }
}

/* Auto-initialise every <… data-slider> element on the page.
   Optional attributes: data-autoplay, data-interval="5000" */
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-slider]").forEach((el) => {
    const options = { autoplay: el.hasAttribute("data-autoplay") };
    if (el.dataset.interval) options.interval = Number(el.dataset.interval);
    new ImageSlider(el, options);
  });
});

window.ImageSlider = ImageSlider;

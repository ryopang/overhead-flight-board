// flap.js — split-flap character component: true two-half mechanical flip physics.
// Each cell has 4 layers: a static front-top/front-bottom (resting state) and two
// animated leaves (flap-leaf-top, flap-leaf-bottom) that rotate around the fold line.

const PHASE_MS = 130; // duration of each half of the flip

class FlapCell {
  constructor(container) {
    this.el = document.createElement('div');
    this.el.className = 'flap-cell';
    this.el.innerHTML = `
      <div class="flap-half flap-front-top"><span class="glyph"></span></div>
      <div class="flap-half flap-front-bottom"><span class="glyph"></span></div>
      <div class="flap-leaf flap-leaf-top"><span class="glyph"></span></div>
      <div class="flap-leaf flap-leaf-bottom"><span class="glyph"></span></div>
    `;
    container.appendChild(this.el);

    this.frontTop = this.el.querySelector('.flap-front-top .glyph');
    this.frontBottom = this.el.querySelector('.flap-front-bottom .glyph');
    this.leafTop = this.el.querySelector('.flap-leaf-top');
    this.leafTopGlyph = this.leafTop.querySelector('.glyph');
    this.leafBottom = this.el.querySelector('.flap-leaf-bottom');
    this.leafBottomGlyph = this.leafBottom.querySelector('.glyph');

    this.current = ' ';
    this._paint(' ');
    this._resetLeaves();
  }

  _paint(ch) {
    this.frontTop.textContent = ch;
    this.frontBottom.textContent = ch;
  }

  _resetLeaves() {
    this.leafTop.style.transition = 'none';
    this.leafTop.style.transform = 'rotateX(0deg)';
    this.leafBottom.style.transition = 'none';
    this.leafBottom.style.transform = 'rotateX(90deg)';
    // force reflow so the next transition change is picked up
    void this.leafTop.offsetHeight;
  }

  /**
   * Flip to a new character. `onClack` fires the instant the flip begins
   * (used to trigger the synthesized clack sound in sync with the visual cascade).
   */
  flipTo(ch, onClack) {
    if (ch === this.current) return;
    const old = this.current;
    this.current = ch;

    this.leafTopGlyph.textContent = old;
    this.leafBottomGlyph.textContent = ch;
    this._resetLeaves();

    if (onClack) onClack();

    requestAnimationFrame(() => {
      this.leafTop.style.transition = `transform ${PHASE_MS}ms cubic-bezier(.5,0,.75,0)`;
      this.leafTop.style.transform = 'rotateX(-90deg)';
    });

    setTimeout(() => {
      this._paint(ch);
      this.leafBottom.style.transition = `transform ${PHASE_MS}ms cubic-bezier(.2,.7,.4,1.05)`;
      this.leafBottom.style.transform = 'rotateX(0deg)';
      // leafTop stays folded away (-90deg) at rest so the static front (now painted
      // with the new character) is what's actually visible — it only comes back to
      // flat for the next flip's opening move, via _resetLeaves().
    }, PHASE_MS);
  }
}

class FlapField {
  constructor(container, width, { staggerMs = 70 } = {}) {
    this.width = width;
    this.staggerMs = staggerMs;
    this.cells = [];
    for (let i = 0; i < width; i++) {
      this.cells.push(new FlapCell(container));
    }
  }

  /** Pad/truncate `str` to field width and flip only the cells that changed. */
  setValue(str, onClack) {
    const padded = (str || '').toUpperCase().slice(0, this.width).padEnd(this.width, ' ');
    for (let i = 0; i < this.width; i++) {
      const ch = padded[i];
      const delay = i * this.staggerMs;
      if (ch !== this.cells[i].current) {
        setTimeout(() => this.cells[i].flipTo(ch, onClack), delay);
      }
    }
  }
}

window.FlapCell = FlapCell;
window.FlapField = FlapField;

// Inserts the registered in-content ad containers into article bodies.
// Price Optimiser rule: each registered DIV ID appears at most once per page, so we place
// ad-incontent, ad-incontent-2, ad-incontent-3 before the 2nd, 4th and 6th <h2>.
const SLOTS = [
  { before: 2, id: 'ad-incontent' },
  { before: 4, id: 'ad-incontent-2' },
  { before: 6, id: 'ad-incontent-3' },
];

const slotNode = (id) => ({
  type: 'element',
  tagName: 'div',
  properties: { id, className: ['ad-slot', 'ad-slot--incontent'], ariaLabel: 'Advertisement' },
  children: [],
});

export default function rehypeAdSlots({ enabled = true, slots = null } = {}) {
  return (tree) => {
    if (!enabled) return;
    const out = [];
    let h2 = 0;
    for (const node of tree.children) {
      if (node.type === 'element' && node.tagName === 'h2') {
        h2++;
        const slot = SLOTS.find((s) => s.before === h2 && (!slots?.length || slots.includes(s.id)));
        if (slot) out.push(slotNode(slot.id));
      }
      out.push(node);
    }
    tree.children = out;
  };
}

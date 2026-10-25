import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/office/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getProducts, createProductEntry, updateProductEntry, deleteProductEntry } from "@/lib/office/api";
import type { Product } from "@/lib/office/products.server";

export const Route = createFileRoute("/office/catalogue")({
  component: CataloguePage,
});

function CataloguePage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    id: "",
    title: "",
    scope: "",
    price: "",
    basis: "",
    offered: true,
    category: "general",
  });

  async function refresh() {
    setLoading(true);
    try {
      setProducts(await getProducts());
      setError(null);
    } catch {
      setError("Could not read the product catalogue.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = await getProducts();
        if (!cancelled) setProducts(next);
      } catch {
        if (!cancelled) setError("Could not read the product catalogue.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function add() {
    if (!draft.title.trim() || !draft.price.trim()) return;
    try {
      await createProductEntry({
        data: {
          id: draft.id.trim() || undefined,
          title: draft.title.trim(),
          scope: draft.scope.trim(),
          price: draft.price.trim(),
          basis: draft.basis.trim(),
          offered: draft.offered,
          category: draft.category.trim() || "general",
        },
      });
      setDraft({ id: "", title: "", scope: "", price: "", basis: "", offered: true, category: "general" });
      await refresh();
    } catch {
      setError("Could not create the product.");
    }
  }

  async function toggleOffered(product: Product) {
    try {
      await updateProductEntry({ data: { id: product.id, patch: { offered: !product.offered } } });
      await refresh();
    } catch {
      setError("Could not update the product.");
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this product?")) return;
    try {
      await deleteProductEntry({ data: { id } });
      await refresh();
    } catch {
      setError("Could not delete the product.");
    }
  }

  return (
    <div className="enter-up mx-auto max-w-5xl">
      <PageHeader
        kicker="Catalogue · products"
        title="Sell anything. Price it here."
        description="The office quotes, invoices and (for recurring items) subscribes to whatever is in this catalogue. Add a product and the office can sell it."
      />

      {error ? <p className="mb-4 text-sm text-warn">{error}</p> : null}

      <Card className="mb-6 p-4">
        <h3 className="font-serif text-lg">Add a product</h3>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Input placeholder="id (optional)" value={draft.id} onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))} />
          <Input placeholder="title" value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
          <Input placeholder="scope" value={draft.scope} onChange={(e) => setDraft((d) => ({ ...d, scope: e.target.value }))} />
          <Input placeholder="price (e.g. R690 / hour)" value={draft.price} onChange={(e) => setDraft((d) => ({ ...d, price: e.target.value }))} />
          <Input placeholder="basis" value={draft.basis} onChange={(e) => setDraft((d) => ({ ...d, basis: e.target.value }))} />
          <Input placeholder="category" value={draft.category} onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))} />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.offered} onChange={(e) => setDraft((d) => ({ ...d, offered: e.target.checked }))} />
            Offered
          </label>
          <Button type="button" size="sm" onClick={() => void add()}>
            Add product
          </Button>
        </div>
      </Card>

      {loading ? (
        <p className="text-sm text-muted">Reading the catalogue…</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl bg-surface shadow-[var(--shadow-border)]">
          {products.map((product) => (
            <li key={product.id} className="grid gap-2 px-4 py-4 sm:grid-cols-[1fr_auto] sm:gap-8">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{product.title}</p>
                  {!product.offered ? <Badge variant="warn">Not offered</Badge> : null}
                  <Badge variant="default">{product.category}</Badge>
                </div>
                <p className="mt-1 text-sm text-muted">{product.scope}</p>
                <p className="mt-1 text-xs text-subtle">{product.basis}</p>
                <p className="mt-1 text-xs text-subtle">id: {product.id}</p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <p className="font-mono text-sm">{product.price}</p>
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => void toggleOffered(product)}>
                    {product.offered ? "Withdraw" : "Offer"}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => void remove(product.id)}>
                    Delete
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { Search, ChevronDown, Check, X, AlertCircle } from 'lucide-react';
import { formatMoney, formatQuantity } from '@/lib/calculations';

export interface SelectableProduct {
  id: string;
  name: string;
  unit: string;
  sale_price: number;
  stock: number;
  minimum_stock?: number;
  active?: boolean;
}

interface SearchableProductSelectProps {
  products: SelectableProduct[];
  value: string;
  onChange: (productId: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  autoFocus?: boolean;
}

export function SearchableProductSelect({
  products,
  value,
  onChange,
  placeholder = 'Search or select a product...',
  disabled = false,
  required = false,
  id,
  autoFocus = false
}: SearchableProductSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedProduct = useMemo(
    () => products.find((p) => p.id === value),
    [products, value]
  );

  // Filter products matching search query
  const filteredProducts = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.unit.toLowerCase().includes(q) ||
        String(p.sale_price).includes(q)
    );
  }, [products, query]);

  // Click outside listener
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      setHighlightedIndex(0);
    }
  }, [isOpen]);

  function handleSelect(productId: string) {
    onChange(productId);
    setIsOpen(false);
    setQuery('');
  }

  function handleClear(e: React.MouseEvent) {
    e.stopPropagation();
    onChange('');
    setQuery('');
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((prev) =>
        prev < filteredProducts.length - 1 ? prev + 1 : 0
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((prev) =>
        prev > 0 ? prev - 1 : filteredProducts.length - 1
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredProducts[highlightedIndex]) {
        handleSelect(filteredProducts[highlightedIndex].id);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsOpen(false);
    }
  }

  return (
    <div
      ref={containerRef}
      className="searchable-select-container"
      style={{ position: 'relative', width: '100%', zIndex: isOpen ? 9999 : 'auto' }}
      onKeyDown={handleKeyDown}
    >
      {/* Trigger Button */}
      <button
        type="button"
        id={id}
        disabled={disabled}
        autoFocus={autoFocus}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        className="searchable-select-trigger"
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          background: disabled ? '#f5f5f5' : '#ffffff',
          border: isOpen ? '1.5px solid var(--forest, #264b3b)' : '1px solid #d1d5db',
          borderRadius: '6px',
          fontSize: '13px',
          color: selectedProduct ? '#111827' : '#6b7280',
          cursor: disabled ? 'not-allowed' : 'pointer',
          textAlign: 'left',
          minHeight: '38px',
          boxShadow: isOpen ? '0 0 0 3px rgba(38, 75, 59, 0.1)' : 'none',
          transition: 'all 0.15s ease'
        }}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden', flex: 1, minWidth: 0 }}>
          <Search size={14} style={{ color: '#9ca3af', flexShrink: 0 }} />
          {selectedProduct ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', minWidth: 0, flex: 1 }}>
              <span style={{ fontWeight: 600, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
                {selectedProduct.name}
              </span>
              <span style={{ fontSize: '11px', color: '#6b7280', whiteSpace: 'nowrap', flexShrink: 0 }}>
                ({selectedProduct.unit})
              </span>
            </div>
          ) : (
            <span style={{ color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {placeholder}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
          {selectedProduct && !disabled && (
            <span
              onClick={handleClear}
              role="button"
              tabIndex={-1}
              style={{
                padding: '2px',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                color: '#9ca3af'
              }}
              title="Clear selection"
            >
              <X size={14} />
            </span>
          )}
          <ChevronDown
            size={14}
            style={{
              color: '#6b7280',
              transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s'
            }}
          />
        </div>
      </button>

      {/* Hidden input for form required validation */}
      {required && (
        <input
          tabIndex={-1}
          required={required}
          value={value}
          onChange={() => {}}
          style={{ opacity: 0, position: 'absolute', pointerEvents: 'none', height: 0, width: 0 }}
        />
      )}

      {/* Dropdown Panel */}
      {isOpen && (
        <div
          className="searchable-select-menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 9999,
            backgroundColor: '#ffffff',
            border: '1px solid #e5e7eb',
            borderRadius: '6px',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
            overflow: 'hidden',
            maxHeight: '280px',
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          {/* Search Input Box */}
          <div style={{ padding: '8px', borderBottom: '1px solid #f3f4f6', backgroundColor: '#f9fafb' }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <Search
                size={14}
                style={{ position: 'absolute', left: '10px', color: '#9ca3af', pointerEvents: 'none' }}
              />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlightedIndex(0);
                }}
                placeholder="Type name, unit, or rate to filter..."
                style={{
                  width: '100%',
                  padding: '6px 10px 6px 30px',
                  fontSize: '12.5px',
                  border: '1px solid #d1d5db',
                  borderRadius: '4px',
                  outline: 'none',
                  backgroundColor: '#ffffff'
                }}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  style={{
                    position: 'absolute',
                    right: '8px',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: '#9ca3af',
                    padding: 0
                  }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>

          {/* Option List */}
          <div style={{ overflowY: 'auto', flex: 1, padding: '4px 0' }}>
            {filteredProducts.length === 0 ? (
              <div
                style={{
                  padding: '16px 12px',
                  textAlign: 'center',
                  fontSize: '12px',
                  color: '#6b7280'
                }}
              >
                No products match &ldquo;{query}&rdquo;
              </div>
            ) : (
              filteredProducts.map((p, index) => {
                const isSelected = p.id === value;
                const isHighlighted = index === highlightedIndex;
                const isOutOfStock = p.stock <= 0;

                return (
                  <div
                    key={p.id}
                    onClick={() => handleSelect(p.id)}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    style={{
                      padding: '8px 12px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      cursor: 'pointer',
                      fontSize: '12.5px',
                      backgroundColor: isHighlighted
                        ? 'rgba(38, 75, 59, 0.08)'
                        : isSelected
                        ? 'rgba(38, 75, 59, 0.04)'
                        : 'transparent',
                      transition: 'background-color 0.1s ease',
                      borderLeft: isSelected ? '3px solid var(--forest, #264b3b)' : '3px solid transparent'
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', overflow: 'hidden' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontWeight: 600, color: '#111827' }}>{p.name}</span>
                        <span style={{ fontSize: '11px', color: '#6b7280' }}>({p.unit})</span>
                        {isSelected && <Check size={13} style={{ color: 'var(--forest, #264b3b)' }} />}
                      </div>
                      <div style={{ fontSize: '11.5px', color: '#4b5563' }}>
                        Selling Rate: <strong>{formatMoney(p.sale_price)}</strong>
                      </div>
                    </div>

                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <span
                        style={{
                          fontSize: '11px',
                          padding: '2px 7px',
                          borderRadius: '12px',
                          fontWeight: 600,
                          backgroundColor: isOutOfStock ? '#fee2e2' : p.stock <= (p.minimum_stock ?? 10) ? '#fef3c7' : '#dcfce7',
                          color: isOutOfStock ? '#b91c1c' : p.stock <= (p.minimum_stock ?? 10) ? '#b45309' : '#15803d',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '3px'
                        }}
                      >
                        {isOutOfStock && <AlertCircle size={10} />}
                        {isOutOfStock ? '0 stock' : `${formatQuantity(p.stock)} ${p.unit}`}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

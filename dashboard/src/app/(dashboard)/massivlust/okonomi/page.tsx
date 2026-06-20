'use client';

import { useState } from 'react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';

const PRICE_MATRIX: Record<string, Record<string, number>> = {
  '2-mann': { rehab_lokal: 8500, rehab_utenbys: 11000, nybygg_lokal: 9200, nybygg_utenbys: 12000 },
  '3-mann': { rehab_lokal: 12500, rehab_utenbys: 16500, nybygg_lokal: 13800, nybygg_utenbys: 18000 },
  '4-mann': { rehab_lokal: 16000, rehab_utenbys: 21000, nybygg_lokal: 17500, nybygg_utenbys: 23000 },
  '5-mann': { rehab_lokal: 19500, rehab_utenbys: 25500, nybygg_lokal: 21500, nybygg_utenbys: 28000 },
};

const COLUMN_LABELS: Record<string, string> = {
  rehab_lokal: 'Rehab (lokal)',
  rehab_utenbys: 'Rehab (utenbys)',
  nybygg_lokal: 'Nybygg (lokal)',
  nybygg_utenbys: 'Nybygg (utenbys)',
};

const TYPE_KEYS: Record<string, string> = {
  'Rehab (lokal)': 'rehab_lokal',
  'Rehab (utenbys)': 'rehab_utenbys',
  'Nybygg (lokal)': 'nybygg_lokal',
  'Nybygg (utenbys)': 'nybygg_utenbys',
};

function formatNok(n: number) {
  return new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK', minimumFractionDigits: 0 }).format(n);
}

export default function MassivlustOkonomiPage() {
  const columns = Object.keys(COLUMN_LABELS);
  const [team, setTeam] = useState('3-mann');
  const [type, setType] = useState('Rehab (lokal)');
  const [days, setDays] = useState(10);
  const [costPerDay, setCostPerDay] = useState(5000);

  const typeKey = TYPE_KEYS[type];
  const dayRate = PRICE_MATRIX[team]?.[typeKey] ?? 0;
  const revenue = dayRate * days;
  const teamSize = parseInt(team);
  const cost = costPerDay * days * teamSize;
  const margin = revenue > 0 ? Math.round(((revenue - cost) / revenue) * 100) : 0;
  const profit = revenue - cost;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Okonomi</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Prismatrise og margin-kalkulator
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Prismatrise</CardTitle>
          <CardDescription>Dagspris per lag-storrelse og prosjekttype (NOK/dag)</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">Lag</th>
                  {columns.map(col => (
                    <th key={col} className="text-right py-3 px-4 font-medium text-muted-foreground">
                      {COLUMN_LABELS[col]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(PRICE_MATRIX).map(([t, prices]) => (
                  <tr key={t} className={`border-b last:border-0 hover:bg-muted/50 ${t === team ? 'bg-primary/5' : ''}`}>
                    <td className="py-3 px-4 font-medium">{t}</td>
                    {columns.map(col => (
                      <td key={col} className={`py-3 px-4 text-right font-mono ${t === team && col === typeKey ? 'text-primary font-semibold' : ''}`}>
                        {formatNok(prices[col])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Margin-kalkulator</CardTitle>
          <CardDescription>Beregn margin basert paa prosjekt-parametere</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Lag-storrelse</label>
              <select
                value={team}
                onChange={e => setTeam(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm bg-background"
              >
                {Object.keys(PRICE_MATRIX).map(t => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Type</label>
              <select
                value={type}
                onChange={e => setType(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm bg-background"
              >
                {Object.keys(TYPE_KEYS).map(t => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Antall dager</label>
              <input
                type="number"
                value={days}
                onChange={e => setDays(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-full rounded-lg border px-3 py-2 text-sm bg-background"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Loennskost/dag/person</label>
              <input
                type="number"
                value={costPerDay}
                onChange={e => setCostPerDay(Math.max(0, parseInt(e.target.value) || 0))}
                className="w-full rounded-lg border px-3 py-2 text-sm bg-background"
              />
            </div>
          </div>

          <div className="mt-6 p-4 bg-muted/50 rounded-xl">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
              <div>
                <p className="text-xs text-muted-foreground">Dagspris</p>
                <p className="text-lg font-semibold mt-1">{formatNok(dayRate)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Inntekt ({days}d)</p>
                <p className="text-lg font-semibold mt-1">{formatNok(revenue)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Kostnad ({teamSize}p x {days}d)</p>
                <p className="text-lg font-semibold mt-1">{formatNok(cost)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Margin</p>
                <p className={`text-lg font-semibold mt-1 ${margin >= 30 ? 'text-emerald-700' : margin >= 15 ? 'text-amber-700' : 'text-red-700'}`}>
                  {margin}% ({formatNok(profit)})
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

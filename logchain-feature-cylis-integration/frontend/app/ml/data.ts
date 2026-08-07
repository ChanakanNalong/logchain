import { Target, TrendingUp, Activity, Brain, type LucideIcon } from 'lucide-react';
import type { Theme } from '@/lib/theme';

export const metricCards: { l: string; v: string; sub: string; icon: LucideIcon; tone: keyof Theme }[] = [
  { l: 'F1 Score', v: '0.7138', sub: 'seed=42, HDFS_v1', icon: TrendingUp, tone: 'good' },
  { l: 'Precision', v: '0.9735', sub: 'TP/(TP+FP)', icon: Target, tone: 'blue' },
  { l: 'Recall', v: '0.5635', sub: 'TP/(TP+FN)', icon: Activity, tone: 'warn' },
  { l: 'Model', v: 'DeepLog', sub: 'LSTM · window=10', icon: Brain, tone: 'cyan' },
];

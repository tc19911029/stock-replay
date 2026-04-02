import { redirect } from 'next/navigation';
export default function BacktestRedirect() {
  redirect('/scanner?mode=full');
}

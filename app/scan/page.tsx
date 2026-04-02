import { redirect } from 'next/navigation';

export default function ScanRedirect() {
  redirect('/scanner?mode=full');
}

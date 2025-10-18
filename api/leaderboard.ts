
import { NextApiRequest, NextApiResponse } from 'next';

let scores: { name: string; score: number; date: number }[] = [];

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    const { name, score } = req.body;
    scores.push({ name, score, date: Date.now() });
    scores = scores.sort((a, b) => b.score - a.score).slice(0, 10);
    return res.status(200).json({ ok: true });
  }
  if (req.method === 'GET') {
    return res.status(200).json(scores);
  }
  res.status(405).end();
}

# Roadmap

## Où on en est
- **Crypto paper-trading desk**, live (Vercel + Render + Neon), feed Coinbase.
- Stratégie **tunée & validée in-sample** : 1h, `mtfConfirm`, break-even, `minVolPct` 1%
  → PF ≈ 1.85 brut, expectancy 0.37R, 8/8 symboles positifs.
- **Réalité des coûts** : l'edge ne survit qu'en frais très bas. Sur frais retail
  (~0.2%/jambe) la stratégie devient **négative**. Cf. backtest `feeRate`/`slipRate`.

## Direction : FOREX
**Pourquoi** : short natif (pas de futures/marge), spreads serrés, API broker avec
**compte démo** (forward-test = adaptateur réel branché), pas de géo-blocage.
**Compromis** : volatilité ~10× plus faible que la crypto → la stratégie doit être
**entièrement ré-optimisée** ; les majors sont efficientes (dur pour une stratégie de tendance).

## Décision API broker (BLOQUANT — à trancher en premier)
L'utilisateur a **JustMarkets** et **HFM** → tous deux **MT4/MT5, PAS d'API REST native**.
- **A. OANDA v20** — API REST native + démo. Le plus propre pour ce desk. Nouveau compte.
- **B. cTrader Open API** — API officielle (OAuth, REST/WS) **si HFM propose cTrader**. Garde le broker.
- **C. MetaApi.cloud** — pont REST payant par-dessus le compte MT5 (HFM/JustMarkets). Garde desk + compte.
- **D. EA MQL5** — réimplémenter la stratégie en MT5. Quitte ce codebase. ❌
Reco : vérifier cTrader sur HFM (B) ; sinon OANDA (A) ou MetaApi/HFM (C). HFM > JustMarkets (régulation).

## Ré-optimisation forex (NE PAS copier les params crypto — tout re-backtester)
- `minVolPct` : 1% → ~0.1-0.2% (ATR forex ~10× plus bas).
- Timeframe : tester 1h / 4h / daily.
- Paires : crosses tendanciels (GBP/JPY, AUD/JPY) + majors ; éviter les rangers.
- Filtre de **session** (overlap Londres/NY) : à tester — peut vraiment aider en forex.
- **Gaps week-end** : gérer fermeture vendredi→dimanche + risque de gap sur les stops.
- Coûts : modéliser spread + commission ECN (outil `feeRate`/`slipRate` déjà en place).

## Plan par étapes
1. **Brancher un feed forex** (OANDA démo, ou Yahoo FX) → données EUR/USD & co.
2. **Backtester + optimiser** la stratégie pour le forex (comme on l'a fait crypto).
3. **Valider net de coûts** (spread + commission).
4. **Forward-test sur compte DÉMO** broker, avec l'adaptateur réel branché.
5. **Seulement après** : réel minuscule (~$100), clés **trade-only** (sans retrait).

## Résultat — baseline forex (stratégie actuelle)
Outil : `backend/scripts/forex-backtest.js` (feed Yahoo FX gratuit, sans clé/compte ;
rejoue `simulate`/`computeSignal`). Testé sur **8 paires, ~2 ans de 1h, 619 trades** :
- **Aucun edge** : agrégat **négatif même brut** (PF 0.91, expR −0.05) et −0.12R net
  d'un spread serré. Winrate ~24% partout (< 33% requis pour le R:R 1:2).
- → Le problème est la **stratégie**, pas l'actif. Ne pas porter le trend-confluence
  tel quel. Prochaine étape : tester d'autres archétypes (mean-reversion sur majors,
  breakout de session Londres/NY, TF 4h/daily) avec ce même harness, garder seulement
  ce qui est positif **net de coûts ET en walk-forward**. Un edge peut ne pas exister
  (résultat valide qui économise du capital).

## Garde-fous
L'assistant ne saisit aucune clé/identifiant, n'exécute aucun ordre réel, ne donne pas
de conseil en investissement. Capital réel = à haut risque, budget d'apprentissage.

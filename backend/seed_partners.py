"""Owner-supplied 2026 Búzios prospect list; names are not verified partnerships."""

from __future__ import annotations

import os
from pathlib import Path

from .store import Store

LODGING = """Pousada Bucaneiro
Pedra da Laguna Boutique Hotel & Spa
Pousada dos Tangarás
Costa do Sol Boutique Hotel
Pousada Byblos
Pousada dos Búzios
Hotel Miratlântico Búzios
Pousada Villa Raphael
La Pedrera Small Hotel & Spa
Auberge de la Langouste
Pousada Vila do Mar Búzios
Hotel Pousada Brava Club
Villa Mercedes Pousada & Spa by Latitud Hoteles
Latitud Búzios Hotel
Pousada Lestada
Pousada Aroma do Mar by Latitud Hoteles
Barra da Lagoa Hotel
Taman Búzios Hotel
Pousada Amancay
Pousada Brisas de Búzios
Pousada Casa Búzios
Pousada Gammel Dansk
Pousada El Parador
Pousada Pelicano
Pousada Blue Marlin
Pousada Pontal da Ferradura
Pousada Vila Pitanga
Pousada Maria Maria
Pousada Corais e Conchas
Pousada da Cyssa
Pousada João Fernandes
Hotel Atlântico Búzios
Búzios Beach Resort
Vila d'este Búzios Hotel
Casas Brancas Boutique Hotel & Spa
Ferradura Resort
Insólito Boutique Hotel & Spa
Chez Pitu Praia Hotel
Pousada Abracadabra
Vila da Santa Hotel Boutique
Azeda Boutique Hotel
Pousada Corsário
La Chimère Búzios Essence
Pousada Praia João Fernandes
Rio Búzios Beach Hotel
Hotel La Forêt
Água Búzios Hotel Pousada
Bamboo Búzios Hostel
Che Lagarto Hostel Búzios
Bela Vista Ferradura
Serena Búzios
Le Relais La Borie
Nativa Búzios
Gringos Boutique Hotel
Praia da Ferradurinha Guest House
Jubarte Conceito Hotel
Riviera Búzios Hotel
Villa Santa Fé
Pousada Águas Claras
Villa Baobá
Pousada Villa Rasa
Baía do João Eco Pousada
Hotel Ville La Plage & Beach Club
Zendaya Resort Beach Sport & Spa"""

FOOD = """Buzin
Chez Michou
Bastidores Restobar
Bar dos Pescadores
Primitivo
Restaurante do David
Mar Azul
Mr. Brad
Estância Don Juan
Noi Búzios
Pátio Havana
Mofaia Mar
La Bardot
Uai Beach Búzios
Anexo Praia Búzios
Golden Bread
Palermo
Casablanca Steak House
Zuza Búzios
O Barco
Rocka Restaurant & Beach Lounge
Duo Market
Madame Bardot Restaurante
Tropical Bistrô
NEO Restaurante | Frutos do mar em Búzios| Peixes, Carnes, Polvo em Armação dos Búzios
The House Of Rock And Roll
Místico Sunset Lounge & Restaurant
74 Restaurant
NAMI Gastrobar
Bar do Zé
Mr. Waiz
Buda Beach Búzios
Maria Italiana
Taverna D'Arte
Forneria Picardia
Forneria Belli
Sushi 11
Bento
Sushi Geribá
Altto Ristorante
Mercado do Porto
Le Sancerre Bistrô
Huna Bistrô
A Galeria
Pizzaria Canoa Azul
Garagem Restobar
Sandubom
White
Sukão Lanchonete
Biroska do Peixe"""

BEACH = """Tawa Beach
Tia Chica
Quiosque Samuca's | Beach Food | Bar e Restaurante Praia da Ferradura - Búzios
Quiosque Siri Moleque
Quiosque Mayamar
Barraca da Alê
Quiosque do Clener
Barraca Do Zaza
Barraca da Jô – Petiscos e Drinks na Praia de Geribá
Quiosque do Chico
A Pomba
Fishbone
Silk Beach Club
Éden Beach Lounge
Belli Belli Aretê
Nativa Búzios Beach Bar"""


def entries() -> list[tuple[str, str]]:
    return [(category, name) for category, names in (
        ("hospedagem", LODGING), ("gastronomia", FOOD), ("praia", BEACH)
    ) for name in names.splitlines()]


def main() -> None:
    all_entries = entries()
    assert len(all_entries) == 130
    assert len({name.casefold() for _, name in all_entries}) == 130
    db_path = Path(os.getenv("VIBZ_DB_PATH", str(Path(__file__).with_name("data") / "vibz.sqlite3")))
    inserted = Store(db_path).seed_partners(all_entries)
    print(f"{inserted} estabelecimentos novos; {len(all_entries)} na base inicial")


if __name__ == "__main__":
    main()

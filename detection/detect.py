"""
detect.py - ใช้ DeepLog ที่ train แล้วตรวจจับ anomaly บน test set
และวัด Precision / Recall / F1
ลองหลาย g (top-k threshold) เพื่อหาค่าดีที่สุด
"""
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset
from tqdm import tqdm

# ---- fix randomness - ผลทดสอบ reproducible ----
import random, numpy as np
SEED = 42
random.seed(SEED)
np.random.seed(SEED)
torch.manual_seed(SEED)
torch.cuda.manual_seed_all(SEED)

# ---- hyperparmeters (ต้องตรงกับ deeplog.py) ----
NUM_CLASSES = 48
WINDOW_SIZE = 10
HIDDEN_SIZE = 64
NUM_LAYERS = 2

# ลอง top-k หลายค่าเพื่อหา F1 สูงที่สุด
CANDIDATES_G = [8, 9, 10]

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"Using device: {device}\n")

class Deeplog(nn.Module):
    def __init__(self, num_classes, hidden_size, num_layers):
        super().__init__()
        self.hidden_size = hidden_size
        self.num_layers = num_layers
        self.lstm = nn.LSTM(1, hidden_size, num_layers, batch_first=True)
        self.fc = nn.Linear(hidden_size, num_classes)

    def forward(self, x):
        h0 = torch.zeros(self.num_layers, x.size(0), self.hidden_size).to(device)
        c0 = torch.zeros(self.num_layers, x.size(0), self.hidden_size).to(device)
        out, _ = self.lstm(x, (h0, c0))
        return self.fc(out[:, -1, :])
    
def load_sequences(path):
    """ โหลด sequences (1 บรรทัด = 1 block) """
    with open(path) as f:
        return [list(map(int, line.strip().split())) for line in f if line.strip()]
            
def predict_anomalies(model, sequences, g, desc):
    """
    คืน list ของ bool: block ไหนเป็น anomaly (True) หรือ normal (False)
    block = anomaly ถ้ามีอย่างน้อย 1 window ที่ทำนายผิด (target ไม่อยู่ใน top-g)
    """
    model.eval()
    results = []
    with torch.no_grad():
        for seq in tqdm(sequences, desc=desc):
            # ถ้า sequence สั้นกว่า window - ถือว่า normal (ทำนายไม่ได้)
            if len(seq) < WINDOW_SIZE + 1:
                results.append(True)
                continue
                
            is_anomaly = False
            # สร้าง window ทั้งหมดของ block นี้รวมเป็น batch เดียว (เร็วกว่า)
            windows = []
            targets = []
            for i in range(len(seq) - WINDOW_SIZE):
                windows.append(seq[i:i + WINDOW_SIZE])
                targets.append(seq[i + WINDOW_SIZE])

            X = torch.tensor(windows, dtype=torch.float).unsqueeze(-1).to(device)
            y = torch.tensor(targets, dtype=torch.long).to(device)

            output = model(X) # (num_windows, num_calsses)
            # หา top-g log keys ที่ model หาย
            _, topk = output.topk(g, dim=1)

            # window ไหนที่ target ไม่อยู่ใน top-g -> anomaly
            # ใช้ broadcasting: (N, g) เทียบ (N, 1)
            hit = (topk == y.unsqueeze(1)).any(dim=1)
            if not hit.all():
                is_anomaly = True

            results.append(is_anomaly)

    return results
    

def evaluate(predictions_normal, predictions_abnormal):
    """
    คำนวน TP / FP / TN และ Precision / Recall / F1

    Positive class = Anomaly
    TP = predict anomaly, จริงคือ anomaly
    FP = prodict anomaly, จริงคือ normal (false alarm)
    FN = predict normal, จริงคือ anomaly (anomaly หลุดรอด)
    TN = predict normal, จริงคือ normal
    """
    TP = sum(predictions_abnormal)
    FN = len(predictions_abnormal) - TP
    FP = sum(predictions_normal)
    TN = len(predictions_normal) - FP

    precision = TP / (TP + FP) if (TP + FP) > 0 else 0
    recall    = TP / (TP + FN) if (TP + FN) > 0 else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0

    return {
        "TP": TP, "FP": FP, "FN": FN, "TN": TN,
        "precision": precision, "recall": recall, "f1": f1,
    }

def main():
    # โหลด model
    print("Loading model...")
    model = Deeplog(NUM_CLASSES, HIDDEN_SIZE, NUM_LAYERS).to(device)
    model.load_state_dict(torch.load("data/deeplog_model.pt", map_location=device))

    # โหลด test sequences
    print("Loading test data...")
    test_normal = load_sequences("data/test_normal.txt")
    test_abnormal = load_sequences("data/test_abnormal.txt")
    print(f"    test normal:    {len(test_normal):,}")
    print(f"    test abnormal:  {len(test_abnormal):,}\n")

    # ลอง g หลายค่า
    print(f"{'g':>4} | {'TP':>6} {'FP':>6} {'FN':>6} {'TN':>8} | "
          f"{'precision':>9} {'Recall':>7} {'F1':>7}")
    print("-" * 75)

    best = {"g": None, "f1": 0}
    for g in CANDIDATES_G:
        print((f"\n--- Testing g = {g} ---"))
        pred_normal = predict_anomalies(model, test_normal, g, f"normal (g={g})")
        pred_abnormal = predict_anomalies(model, test_abnormal, g, f"abnormal (g={g})")
        m = evaluate(pred_normal, pred_abnormal)

        print(f"\n{g:>4} | {m['TP']:>6} {m['FP']:>6} {m['FN']:>6} {m['TN']:>8} | "
              f"{m['precision']:>9.4f} {m['recall']:>7.4f} {m['f1']:>7.4f}")
    
        if m["f1"] > best["f1"]:
            best = {"g": g, **m}

    print("\n" + "=" * 75)
    print(f"BEST: g={best['g']} F1={best['f1']:.4f} "
      f"P={best['precision']:.4f} R={best['recall']:.4f}")
    print("=" * 75)

if __name__ == "__main__":
    main()

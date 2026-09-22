"""
deeplog.py - Deeplog (LSTM) สำหรับ HDFS log anomaly datection
train ด้วย normal sequences เท่านั้น (semi-supervised)
"""
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset
from tqdm import tqdm

# ---- hyperparameters ----
NUM_CLASSES = 48    # 47 log key + 1 (index 0 เมื่อ padding/unknown)
WINDOW_SIZE = 10    # คู 10 ตัวก่อนหน้า ทำหายตัวที่ 11
HIDDEN_SIZE = 64    # ขนาด LSTM hidden state
NUM_LAYERS  = 2     # LSTM 2 ชิ้น (ตามต้นฉบับ)
BATCH_SIZE  = 2048  # 4GB VRAM รับได้สบายเพราะ model เล็ก
EPOCHS      = 30
LR          = 0.001

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"Using device: {device}")

class Deeplog(nn.Module):
    def __init__(self, num_classes, hidden_size, num_layers):
        super().__init__()
        self.hidden_size = hidden_size
        self.num_layers = num_layers
        # input เป็น log key ตัวเดียวต่อ step (feature dim = 1)
        self.lstm = nn.LSTM(1, hidden_size, num_layers, batch_first=True)
        self.fc = nn.Linear(hidden_size, num_classes)

    def forward(self, x):
        # x shape: (batch, window_size< 1)
        h0 = torch.zeros(self.num_layers, x.size(0), self.hidden_size).to(device)
        c0 = torch.zeros(self.num_layers, x.size(0), self.hidden_size).to(device)
        out, _ = self.lstm(x, (h0, c0))
        # เอา output ของ step สุดท้ายไปทำนาย log key ตัวต่อไป
        return self.fc(out[:, -1, :])
    
def make_windows(path, window_size):
    """ แปลง sequences เป็น (input window, target) pairs """
    inputs, targets = [], []
    with open(path) as f:
        for line in f:
            keys = list(map(int, line.strip().split()))
            # sliding window
            for i in range(len(keys) - window_size):
                inputs.append(keys[i:i + window_size])
                targets.append(keys[i + window_size])
    return inputs, targets
    
def train():
    print("Builing training window...")
    inputs, targets = make_windows("data/train.txt", WINDOW_SIZE)
    print(f"    {len(inputs):,} window")

    X = torch.tensor(inputs, dtype=torch.float).unsqueeze(-1) # (M, window, 1)
    y = torch.tensor(targets, dtype=torch.long)
    loader = DataLoader(TensorDataset(X, y), batch_size=BATCH_SIZE, shuffle=True)

    model = Deeplog(NUM_CLASSES, HIDDEN_SIZE, NUM_LAYERS).to(device)
    criterion = nn.CrossEntropyLoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=LR)

    print("Training...")
    for epoch in range(EPOCHS):
        model.train()
        total_loss = 0
        for X_batch, y_batch in tqdm(loader, desc=f"Epoch {epoch+1}/{EPOCHS}"):
            X_batch, y_batch = X_batch.to(device), y_batch.to(device)
            optimizer.zero_grad()
            output = model(X_batch)
            loss = criterion(output, y_batch)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
        print(f"  Epoch {epoch+1} loss: {total_loss/len(loader):.4f}")

    torch.save(model.state_dict(), "data/deeplog_model.pt")
    print("\nSaved model to data/deeplog_model.pt")

if __name__ == "__main__":
    train()
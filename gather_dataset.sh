rm -rf datasets
# Create the target directory
mkdir -p datasets

# Initialize a counter
count=1

# Find and copy files with new sequential names
find ./workspaces -type f -name "messages.jsonl" | while read -r filepath; do
    cp "$filepath" "datasets/messages${count}.jsonl"
    echo "Copied: $filepath -> datasets/messages${count}.jsonl"
    count=$((count + 1))
done

python extract_dataset.py
python inject_tools.py

import json
import glob
import os

def process_messages():
    # Target the directory we just created
    dataset_dir = "datasets"
    file_pattern = os.path.join(dataset_dir, "messages*.jsonl")
    
    for filepath in glob.glob(file_pattern):
        processed_lines = []
        
        with open(filepath, 'r', encoding='utf-8') as f:
            for line in f:
                if not line.strip():
                    continue
                    
                data = json.loads(line)
                new_parts = []
                
                # Accumulators for combining streaming text
                current_text = ""
                current_is_thought = None
                
                def flush_text():
                    """Helper to append accumulated text to new_parts."""
                    nonlocal current_text, current_is_thought, new_parts
                    if current_text:
                        if current_is_thought:
                            new_parts.append({"thought": True, "text": current_text})
                        else:
                            new_parts.append({"text": current_text})
                        current_text = ""
                        current_is_thought = None

                for part in data.get("parts", []):
                    if "text" in part:
                        is_thought = part.get("thought", False)
                        
                        # If the type of text changes (e.g., from thought to normal text), flush the current buffer
                        if current_is_thought is not None and is_thought != current_is_thought:
                            flush_text()
                            
                        current_text += part["text"]
                        current_is_thought = is_thought
                    else:
                        # If it's a functionCall or functionResponse, flush text and append the object as-is
                        flush_text()
                        new_parts.append(part)
                        
                # Flush any remaining text at the end of the parts array
                flush_text()
                
                # Replace the fragmented parts with the consolidated ones
                data["parts"] = new_parts
                processed_lines.append(data)
                
        # Overwrite the file with the cleaned data
        with open(filepath, 'w', encoding='utf-8') as f:
            for d in processed_lines:
                f.write(json.dumps(d) + '\n')
                
        print(f"Processed: {filepath}")

if __name__ == "__main__":
    process_messages()

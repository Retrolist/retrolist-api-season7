import json
from collections import defaultdict

# Load the JSON data
file_path = 'data/agora_projects_raw.json'
with open(file_path, 'r', encoding='utf-8') as file:
    data = json.load(file)
    
def flatten_one_level(nested_list):
    flat_list = []
    for item in nested_list:
        if isinstance(item, list):
            flat_list.extend(item)
        else:
            flat_list.append(item)
    return flat_list

# Function to merge projects by id and check for consistency
def merge_projects(data):
    data = flatten_one_level(data)
    projects_dict = defaultdict(list)
    
    # Group projects by id
    for project in data:
        projects_dict[project['id']].append(project)
    
    # Check for consistency and merge
    merged_projects = []
    inconsistencies = []
    
    for project_id, projects in projects_dict.items():
        if len(projects) == 1:
            merged_projects.append(projects[0])
        else:
            base_project = projects[0]
            consistent = True
            for project in projects[1:]:
                if project != base_project:
                    consistent = False
                    break
            if consistent:
                merged_projects.append(base_project)
            else:
                inconsistencies.append((project_id, projects))
    
    return merged_projects, inconsistencies

merged_projects, inconsistencies = merge_projects(data)

print(len(merged_projects))

# Save the merged projects to a new JSON file
merged_file_path = 'data/agora_projects.json'
with open(merged_file_path, 'w', encoding='utf-8') as merged_file:
    json.dump(merged_projects, merged_file, indent=2)

merged_file_path, inconsistencies

print(len(inconsistencies))